// Sonos, lokaal via UPnP/SOAP op poort 1400 (geen cloud, geen account).
// Vindt spelers via SSDP of via opgegeven IP-adressen en levert per zichtbare
// speler een `media_player.<kamer>` in Home Assistant-stijl. Favorieten staan
// in `source_list` en start je met `select_source`.

var cfg = hub.settings;
var POLL = Math.max(2, Number(cfg.interval) || 3) * 1000;

var players = {};      // uuid -> {uuid, ip, name, id, coordinator (uuid), failures}
var favorites = [];    // [{title, uri, meta}]
var anyIp = null;

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sonos'; }
var esc = hub.xml.escape;

function soap(ip, path, service, action, args) {
  var ns = 'urn:schemas-upnp-org:service:' + service + ':1';
  var body = '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + ns + '">' + (args || '') + '</u:' + action + '></s:Body></s:Envelope>';
  var r = hub.http.request({
    method: 'POST', url: 'http://' + ip + ':1400' + path, timeout: 4000, body: body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPACTION': '"' + ns + '#' + action + '"' }
  });
  if (!r.ok) {
    var code = /<errorCode>(\d+)<\/errorCode>/.exec(r.body);
    throw new Error(action + ' mislukt (HTTP ' + r.status + (code ? ', UPnP ' + code[1] : '') + ')');
  }
  return hub.xml.parse(r.body);
}
var AVT = ['/MediaRenderer/AVTransport/Control', 'AVTransport'];
var RC = ['/MediaRenderer/RenderingControl/Control', 'RenderingControl'];
function avt(ip, action, args) { return soap(ip, AVT[0], AVT[1], action, '<InstanceID>0</InstanceID>' + (args || '')); }
function rc(ip, action, args) { return soap(ip, RC[0], RC[1], action, '<InstanceID>0</InstanceID>' + (args || '')); }

// ------------------------------------------------------------------ zoeken

function candidateIps() {
  var manual = String(cfg.hosts || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  if (manual.length) return manual;
  var search = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\n' +
    'ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n';
  var found = {};
  ['239.255.255.250', '255.255.255.255'].forEach(function (host) {
    if (Object.keys(found).length) return;
    try {
      hub.udp.request({ host: host, port: 1900, data: search, timeout: 2500, maxReplies: 0 }).forEach(function (r) {
        if (/Sonos|ZonePlayer/i.test(r.data)) found[r.host] = true;
      });
    } catch (e) { hub.warn('Zoeken via ' + host + ' mislukt: ' + e.message); }
  });
  var ips = Object.keys(found);
  var last = hub.storage.get('ips', []);
  if (ips.length) hub.storage.set('ips', ips);
  return ips.length ? ips : last;
}

// Eén speler kent de hele opstelling: alle kamers, groepen en wie de groep aanstuurt
function loadTopology() {
  var ips = candidateIps();
  var state = null;
  for (var i = 0; i < ips.length && !state; i++) {
    try {
      var res = soap(ips[i], '/ZoneGroupTopology/Control', 'ZoneGroupTopology', 'GetZoneGroupState');
      state = hub.xml.parse(hub.xml.text(res, 'ZoneGroupState'));
      anyIp = ips[i];
    } catch (e) { hub.warn(ips[i] + ': ' + e.message); }
  }
  if (!state) {
    if (!Object.keys(players).length) hub.warn('Geen Sonos-speler gevonden. Vul eventueel het IP-adres in bij de instellingen.');
    return;
  }
  var seen = {};
  hub.xml.findAll(state, 'ZoneGroup').forEach(function (group) {
    var coordinator = group.attrs.Coordinator;
    (group.children || []).forEach(function (m) {
      if (m.name !== 'ZoneGroupMember' || m.attrs.Invisible === '1') return;
      var ip = (/\/\/([^:\/]+)/.exec(m.attrs.Location || '') || [])[1];
      if (!ip) return;
      var uuid = m.attrs.UUID;
      seen[uuid] = true;
      var p = players[uuid] || { uuid: uuid, failures: 0, last: null };
      p.ip = ip;
      p.name = m.attrs.ZoneName || 'Sonos';
      p.id = 'media_player.' + slug(p.name);
      p.coordinator = coordinator;
      players[uuid] = p;
    });
  });
  Object.keys(players).forEach(function (uuid) {
    if (!seen[uuid]) { hub.entities.remove(players[uuid].id); delete players[uuid]; }
  });
}

function loadFavorites() {
  // Vraag het aan een zichtbare speler: surround-speakers en subs kennen de favorieten niet
  var uuids = Object.keys(players);
  var ip = uuids.length ? coordinatorIp(players[uuids[0]]) : anyIp;
  if (!ip) return;
  try {
    var res = soap(ip, '/MediaServer/ContentDirectory/Control', 'ContentDirectory', 'Browse',
      '<ObjectID>FV:2</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>' +
      '<StartingIndex>0</StartingIndex><RequestedCount>100</RequestedCount><SortCriteria></SortCriteria>');
    var didl = hub.xml.parse(hub.xml.text(res, 'Result'));
    favorites = hub.xml.findAll(didl, 'item').map(function (item) {
      return {
        title: hub.xml.text(item, 'dc:title'),
        uri: hub.xml.text(item, 'res'),
        meta: hub.xml.text(item, 'r:resMD')
      };
    }).filter(function (f) { return f.title && f.uri; });
  } catch (e) { hub.warn('Favorieten ophalen mislukt: ' + e.message); }
}

// ------------------------------------------------------------------ status

function coordinatorIp(p) {
  var c = players[p.coordinator];
  return c ? c.ip : p.ip;
}

function artUrl(ip, uri) {
  if (!uri) return '';
  return uri.indexOf('http') === 0 ? uri : 'http://' + ip + ':1400' + uri;
}

function refresh(p) {
  var cip = coordinatorIp(p);
  var transport = hub.xml.text(avt(cip, 'GetTransportInfo'), 'CurrentTransportState');
  var pos = avt(cip, 'GetPositionInfo');
  var trackUri = hub.xml.text(pos, 'TrackURI');
  var metaText = hub.xml.text(pos, 'TrackMetaData');
  var meta = metaText && metaText !== 'NOT_IMPLEMENTED' ? hub.xml.parse(metaText) : null;
  var title = meta ? hub.xml.text(meta, 'dc:title') : '';
  var artist = meta ? hub.xml.text(meta, 'dc:creator') : '';
  var album = meta ? hub.xml.text(meta, 'upnp:album') : '';
  var art = meta ? hub.xml.text(meta, 'upnp:albumArtURI') : '';
  var stream = meta ? hub.xml.text(meta, 'r:streamContent') : '';
  var source = '';
  // Radio: de titel van het nummer zit in streamContent, de zendernaam in de media-info
  if (/^(x-sonosapi-stream|x-sonosapi-radio|x-rincon-mp3radio|aac:|hls-radio)/.test(trackUri)) {
    try {
      var mediaMeta = hub.xml.text(avt(cip, 'GetMediaInfo'), 'CurrentURIMetaData');
      if (mediaMeta) {
        var mm = hub.xml.parse(mediaMeta);
        source = hub.xml.text(mm, 'dc:title');
        art = art || hub.xml.text(mm, 'upnp:albumArtURI');
      }
    } catch (e) { }
    if (stream && stream.indexOf('ZPSTR_') !== 0) {
      var parts = stream.split(' - ');
      if (parts.length >= 2) { artist = parts[0]; title = parts.slice(1).join(' - '); } else { title = stream; artist = source; }
    } else { title = source || title; artist = ''; }
  }
  var volume = Number(hub.xml.text(rc(p.ip, 'GetVolume', '<Channel>Master</Channel>'), 'CurrentVolume')) || 0;
  var muted = hub.xml.text(rc(p.ip, 'GetMute', '<Channel>Master</Channel>'), 'CurrentMute') === '1';

  var state = { PLAYING: 'playing', TRANSITIONING: 'playing', PAUSED_PLAYBACK: 'paused', STOPPED: 'idle' }[transport] || 'idle';
  var group = Object.keys(players).filter(function (u) { return players[u].coordinator === p.coordinator; })
    .map(function (u) { return players[u].id; });
  var entity = {
    id: p.id, name: p.name, state: state,
    attributes: {
      media_title: state === 'idle' && !title ? '' : title,
      media_artist: artist,
      media_album_name: album,
      entity_picture: artUrl(cip, art),
      volume_level: volume / 100,
      is_volume_muted: muted,
      source: source,
      source_list: favorites.map(function (f) { return f.title; }),
      group_members: group,
      media_duration: hub.xml.text(pos, 'TrackDuration'),
      media_position: hub.xml.text(pos, 'RelTime'),
      device_class: 'speaker',
      ip_address: p.ip
    },
    services: ['media_play', 'media_pause', 'media_play_pause', 'media_stop', 'media_next_track',
      'media_previous_track', 'volume_set', 'volume_up', 'volume_down', 'volume_mute', 'select_source']
  };
  var text = JSON.stringify(entity);
  if (text !== p.last) { p.last = text; hub.entities.publish(entity); }
}

function poll() {
  Object.keys(players).forEach(function (uuid) {
    var p = players[uuid];
    try {
      refresh(p);
      p.failures = 0;
    } catch (e) {
      p.failures++;
      if (p.failures === 3) {
        hub.warn(p.name + ' reageert niet: ' + e.message);
        p.last = null;
        hub.entities.publish({ id: p.id, name: p.name, state: 'unavailable', attributes: { reason: 'Speler reageert niet' } });
      }
    }
  });
}

// ------------------------------------------------------------------ acties

function playFavorite(p, title) {
  var fav = favorites.filter(function (f) { return f.title === title; })[0] ||
    favorites.filter(function (f) { return f.title.toLowerCase() === String(title).toLowerCase(); })[0];
  if (!fav) throw new Error('Favoriet "' + title + '" niet gevonden');
  var cip = coordinatorIp(p);
  var isContainer = /^x-rincon-cpcontainer:|^x-rincon-playlist:|^file:\/\/\/jffs\/settings\/savedqueues/.test(fav.uri) ||
    /object\.container/.test(fav.meta);
  if (isContainer) {
    // Albums en afspeellijsten gaan via de wachtrij
    var coordinator = players[p.coordinator] || p;
    avt(cip, 'RemoveAllTracksFromQueue');
    avt(cip, 'AddURIToQueue', '<EnqueuedURI>' + esc(fav.uri) + '</EnqueuedURI><EnqueuedURIMetaData>' + esc(fav.meta) +
      '</EnqueuedURIMetaData><DesiredFirstTrackNumberEnqueued>0</DesiredFirstTrackNumberEnqueued><EnqueueAsNext>0</EnqueueAsNext>');
    avt(cip, 'SetAVTransportURI', '<CurrentURI>x-rincon-queue:' + coordinator.uuid + '#0</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>');
  } else {
    avt(cip, 'SetAVTransportURI', '<CurrentURI>' + esc(fav.uri) + '</CurrentURI><CurrentURIMetaData>' + esc(fav.meta) + '</CurrentURIMetaData>');
  }
  avt(cip, 'Play', '<Speed>1</Speed>');
}

function setVolume(p, level) {
  var v = Math.max(0, Math.min(100, Math.round(level)));
  rc(p.ip, 'SetVolume', '<Channel>Master</Channel><DesiredVolume>' + v + '</DesiredVolume>');
}

hub.onAction(function (entityId, service, data) {
  var p = null;
  Object.keys(players).forEach(function (u) { if (players[u].id === entityId) p = players[u]; });
  if (!p) return hub.warn('Onbekende speler: ' + entityId);
  var cip = coordinatorIp(p);
  var current = hub.entities.get(entityId);
  var volume = current ? Math.round((current.attributes.volume_level || 0) * 100) : 20;
  try {
    switch (service) {
      case 'media_play': avt(cip, 'Play', '<Speed>1</Speed>'); break;
      case 'media_pause': avt(cip, 'Pause'); break;
      case 'media_play_pause':
        if (current && current.state === 'playing') avt(cip, 'Pause'); else avt(cip, 'Play', '<Speed>1</Speed>');
        break;
      case 'media_stop': avt(cip, 'Stop'); break;
      case 'media_next_track': avt(cip, 'Next'); break;
      case 'media_previous_track': avt(cip, 'Previous'); break;
      case 'volume_set': setVolume(p, Number(data.volume_level) * 100); break;
      case 'volume_up': setVolume(p, volume + 3); break;
      case 'volume_down': setVolume(p, volume - 3); break;
      case 'volume_mute':
        rc(p.ip, 'SetMute', '<Channel>Master</Channel><DesiredMute>' + (data.is_volume_muted ? 1 : 0) + '</DesiredMute>');
        break;
      case 'select_source': playFavorite(p, data.source); break;
      default: hub.warn('Onbekende service: ' + service);
    }
  } catch (e) {
    hub.warn(p.name + ': ' + e.message);
  }
  setTimeout(poll, 400);
});

loadTopology();
loadFavorites();
poll();
setInterval(poll, POLL);
setInterval(loadTopology, 60 * 1000);
setInterval(loadFavorites, 10 * 60 * 1000);
