// Motionblinds / Brel Home: zonneschermen en rolluiken, lokaal via UDP naar de
// bridge (poort 32100; statusmeldingen via multicast 238.0.0.18:32101).
// Levert per scherm een `cover.<naam>` in Home Assistant-stijl.
// De sleutel staat in de Brel/Motionblinds-app: Instellingen → Over → 5× snel
// op de pagina tikken (16 tekens, bijv. 12ab345c-d67e-8f).

var cfg = hub.settings;
var KEY = String(cfg.key || '').trim();
var INVERT = !!cfg.invert;
var MULTICAST = '238.0.0.18';

var gateways = {};   // ip -> {ip, mac, token, deviceType}
var blinds = {};     // mac -> {mac, deviceType, gateway (ip), id, name, data, failures}

function pad(n, len) { var s = String(n); while (s.length < len) s = '0' + s; return s; }
function msgId() {
  var d = new Date();
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2) + pad(d.getUTCHours(), 2) +
    pad(d.getUTCMinutes(), 2) + pad(d.getUTCSeconds(), 2) + pad(d.getUTCMilliseconds(), 3);
}

function request(host, msg, timeout, all) {
  msg.msgID = msgId();
  var replies = hub.udp.request({ host: host, port: 32100, data: JSON.stringify(msg), timeout: timeout || 3000, maxReplies: all ? 0 : 1 });
  var parsed = [];
  replies.forEach(function (r) {
    try { var o = JSON.parse(r.data); o._host = r.host; parsed.push(o); } catch (e) { }
  });
  return all ? parsed : parsed[0] || null;
}

// AccessToken = AES-128-ECB(sleutel, token van de bridge), als hoofdletter-hex
function accessToken(gw) {
  if (KEY.length !== 16) throw new Error('De sleutel moet 16 tekens zijn (zie de Brel-app)');
  if (!gw.token) throw new Error('Nog geen token van de bridge ontvangen');
  return hub.crypto.aes({ mode: 'ecb', key: KEY, data: gw.token, padding: 'none', cipherEnc: 'hex' }).toUpperCase();
}

function nameOf(mac, type) {
  var custom = (cfg.names || []).filter(function (n) { return String(n.mac || '').toLowerCase() === mac.toLowerCase().slice(-4) || n.mac === mac; })[0];
  if (custom && custom.name) return custom.name;
  // Zelfde naamgeving als de Home Assistant-integratie: "RollerBlind 0002"
  var kinds = { 1: 'RollerBlind', 2: 'VenetianBlind', 3: 'RomanBlind', 4: 'HoneycombBlind', 5: 'ShangriLaBlind',
    6: 'RollerShutter', 7: 'RollerGate', 8: 'Awning', 9: 'TopDownBottomUp', 10: 'DayNightBlind', 11: 'DimmingBlind',
    12: 'Curtain', 13: 'CurtainLeft', 14: 'CurtainRight', 42: 'VerticalBlind' };
  return (kinds[type] || 'Blind') + ' ' + mac.slice(-4);
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

function applyDeviceList(ack) {
  if (!ack || ack.msgType !== 'GetDeviceListAck') return;
  var gw = gateways[ack._host] || { ip: ack._host };
  gw.mac = ack.mac; gw.token = ack.token || gw.token; gw.deviceType = ack.deviceType;
  gateways[gw.ip] = gw;
  (ack.data || []).forEach(function (d) {
    if (d.mac === ack.mac && String(d.deviceType).indexOf('0200') === 0) return;   // de bridge zelf
    var b = blinds[d.mac] || { mac: d.mac, failures: 0, data: null };
    b.deviceType = d.deviceType;
    b.gateway = gw.ip;
    blinds[d.mac] = b;
  });
}

function discover() {
  var host = String(cfg.host || '').trim();
  try {
    if (host) applyDeviceList(request(host, { msgType: 'GetDeviceList' }, 3000));
    else request(MULTICAST, { msgType: 'GetDeviceList' }, 3000, true).forEach(applyDeviceList);
  } catch (e) { hub.warn('Zoeken naar de bridge mislukt: ' + e.message); }
  if (!Object.keys(gateways).length) hub.warn('Geen Motionblinds/Brel-bridge gevonden' + (host ? ' op ' + host : '. Vul eventueel het IP-adres in.'));
}

function publish(b) {
  var d = b.data || {};
  b.name = nameOf(b.mac, d.type);
  b.id = b.id || 'cover.' + slug(b.name);
  var raw = typeof d.currentPosition === 'number' ? d.currentPosition : null;   // 0 = open, 100 = dicht
  if (raw !== null && INVERT) raw = 100 - raw;
  var state = raw === null ? 'unknown' : (raw >= 100 ? 'closed' : 'open');
  var attrs = { device_class: 'shade', mac: b.mac };
  if (raw !== null) attrs.current_position = 100 - raw;
  if (typeof d.batteryLevel === 'number' && d.batteryLevel > 0) attrs.battery_voltage = d.batteryLevel / 100;
  if (typeof d.RSSI === 'number') attrs.rssi = d.RSSI;
  hub.entities.publish({
    id: b.id, name: b.name, state: state, attributes: attrs,
    services: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position']
  });
}

function read(b) {
  var ack = request(b.gateway, { msgType: 'ReadDevice', mac: b.mac, deviceType: b.deviceType }, 3000);
  if (!ack || !ack.data) throw new Error('geen antwoord op ReadDevice');
  b.data = ack.data;
  b.failures = 0;
  publish(b);
}

function poll() {
  if (!Object.keys(blinds).length) discover();
  Object.keys(blinds).forEach(function (mac) {
    var b = blinds[mac];
    try { read(b); } catch (e) {
      b.failures++;
      if (b.failures === 3) {
        hub.warn((b.name || mac) + ' reageert niet: ' + e.message);
        if (b.id) hub.entities.publish({ id: b.id, name: b.name, state: 'unavailable', attributes: { reason: 'Bridge reageert niet' } });
      }
    }
  });
}

function write(b, data) {
  var gw = gateways[b.gateway];
  var msg = { msgType: 'WriteDevice', mac: b.mac, deviceType: b.deviceType, AccessToken: accessToken(gw), data: data };
  var ack = request(b.gateway, msg, 4000);
  if (!ack) throw new Error('geen antwoord van de bridge');
  if (ack.actionResult) {
    // Token verlopen of sleutel fout: token verversen en één keer opnieuw proberen
    applyDeviceList(request(b.gateway, { msgType: 'GetDeviceList' }, 3000));
    msg.AccessToken = accessToken(gateways[b.gateway]);
    ack = request(b.gateway, msg, 4000);
    if (!ack || ack.actionResult) throw new Error('bridge weigert de opdracht (' + ((ack && ack.actionResult) || 'geen antwoord') + ') — klopt de sleutel?');
  }
  if (ack.data) { b.data = ack.data; publish(b); }
}

hub.onAction(function (entityId, service, data) {
  var b = null;
  Object.keys(blinds).forEach(function (mac) { if (blinds[mac].id === entityId) b = blinds[mac]; });
  if (!b) return hub.warn('Onbekend scherm: ' + entityId);
  try {
    // Bridge: operation 1 = omhoog/open, 0 = omlaag/dicht, 2 = stop
    if (service === 'open_cover') write(b, { operation: INVERT ? 0 : 1 });
    else if (service === 'close_cover') write(b, { operation: INVERT ? 1 : 0 });
    else if (service === 'stop_cover') write(b, { operation: 2 });
    else if (service === 'set_cover_position') {
      var target = 100 - Math.max(0, Math.min(100, Number(data.position)));
      write(b, { targetPosition: INVERT ? 100 - target : target });
    } else return hub.warn('Onbekende service: ' + service);
    // De motor meldt zijn eindstand zelf (multicast); vraag voor de zekerheid nog eens na
    setTimeout(function () { try { write(b, { operation: 5 }); } catch (e) { } }, 20000);
    setTimeout(function () { try { read(b); } catch (e) { } }, 45000);
  } catch (e) {
    hub.warn((b.name || entityId) + ': ' + e.message);
  }
});

// Statusmeldingen en heartbeats (met vers token) van de bridge
try {
  hub.udp.open({ port: 32101, multicast: MULTICAST }).onMessage(function (m) {
    var o;
    try { o = JSON.parse(m.data); } catch (e) { return; }
    if (o.msgType === 'Heartbeat' && gateways[m.host]) {
      if (o.token) gateways[m.host].token = o.token;
    } else if (o.msgType === 'Report' && blinds[o.mac] && o.data) {
      blinds[o.mac].data = o.data;
      publish(blinds[o.mac]);
    }
  });
} catch (e) {
  hub.warn('Luisteren naar statusmeldingen lukt niet (' + e.message + '); de stand wordt alleen periodiek opgehaald');
}

if (!KEY) hub.warn('Vul de sleutel uit de Brel/Motionblinds-app in; zonder sleutel is alleen de stand te zien');
discover();
poll();
setInterval(poll, Math.max(15, Number(cfg.interval) || 60) * 1000);
setInterval(discover, 10 * 60 * 1000);
