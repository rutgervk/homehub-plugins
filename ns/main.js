// NS-reisplanner: per ingesteld traject de reizen van het komende uur,
// inclusief overstappen (endpoint v3/trips, niet het vertrekbord).
// Levert per traject een entiteit `sensor.ns_<van>_<naar>` met attribuut `trips`.

var cfg = hub.settings;
var BASE = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips';

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

// NS-datums hebben een offset zonder dubbele punt: 2026-07-10T14:12:00+0200
function parseNs(s) {
  var m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}):?(\d{2})$/.exec(s || '');
  return m ? new Date(m[1] + m[2] + ':' + m[3]) : null;
}
// De tijd in de tekst is al Nederlandse tijd; neem HH:MM letterlijk over
function hhmm(s) { return (s || '').substr(11, 5); }

function routes() {
  return (cfg.routes || []).filter(function (r) { return r.from && r.to; }).map(function (r) {
    // Een stationscode (HIL) of de volledige naam (Amsterdam Centraal) mag allebei
    var from = String(r.from).trim(), to = String(r.to).trim();
    return { from: from, to: to, name: (r.name || '').trim(), id: 'sensor.ns_' + slug(from) + '_' + slug(to) };
  });
}

function fetchTrips(route) {
  var url = BASE + '?fromStation=' + encodeURIComponent(route.from) + '&toStation=' + encodeURIComponent(route.to) +
    '&dateTime=' + encodeURIComponent(new Date().toISOString().replace(/\.\d+Z$/, 'Z')) +
    '&searchForArrival=false&travelAssistance=false';
  var r = hub.http.request({ url: url, headers: { 'Ocp-Apim-Subscription-Key': cfg.api_key } });
  if (r.status === 401 || r.status === 403) throw new Error('NS API-key geweigerd — controleer de key in de instellingen');
  if (!r.ok) throw new Error('NS API antwoordde met HTTP ' + r.status);
  var now = Date.now();
  var limit = now + (Number(cfg.window) || 60) * 60000;
  var out = [], fromName = '', toName = '';
  (r.json().trips || []).forEach(function (trip) {
    var legs = trip.legs || [];
    if (!legs.length || !legs[0].origin) return;
    var origin = legs[0].origin, dest = legs[legs.length - 1].destination || {};
    fromName = fromName || origin.name || '';
    toName = toName || dest.name || '';
    var planned = parseNs(origin.plannedDateTime);
    if (!planned) return;
    var actualText = origin.actualDateTime || origin.plannedDateTime;
    var actual = parseNs(actualText) || planned;
    if (actual.getTime() < now - 60000 || actual.getTime() > limit) return;
    var arrPlannedText = dest.plannedDateTime || origin.plannedDateTime;
    var arrActualText = dest.actualDateTime || arrPlannedText;
    var arrPlanned = parseNs(arrPlannedText), arrActual = parseNs(arrActualText);
    var cancelled = String(trip.status || '').toUpperCase() === 'CANCELLED' ||
      legs.some(function (l) { return l.cancelled === true; });
    out.push({
      departure: hhmm(actualText),
      departure_planned: hhmm(origin.plannedDateTime),
      departure_ts: actual.getTime(),
      delay: Math.round((actual.getTime() - planned.getTime()) / 60000),
      arrival: hhmm(arrActualText),
      arrival_delay: arrPlanned && arrActual ? Math.round((arrActual.getTime() - arrPlanned.getTime()) / 60000) : 0,
      transfers: typeof trip.transfers === 'number' ? trip.transfers : legs.length - 1,
      track: origin.actualTrack || origin.plannedTrack || '',
      cancelled: cancelled
    });
  });
  return { trips: out.slice(0, Number(cfg.max) || 6), fromName: fromName, toName: toName };
}

var names = hub.storage.get('names', {});

function refresh() {
  routes().forEach(function (route) {
    var title = route.name || names[route.id] || (route.from + ' → ' + route.to);
    if (!cfg.api_key) {
      hub.entities.publish({ id: route.id, name: title, state: 'unavailable', attributes: { reason: 'Vul de NS API-key in', trips: [] } });
      return;
    }
    try {
      var res = fetchTrips(route);
      if (!route.name && res.fromName && res.toName) {
        title = res.fromName + ' → ' + res.toName;
        if (names[route.id] !== title) { names[route.id] = title; hub.storage.set('names', names); }
      }
      var next = res.trips.filter(function (t) { return !t.cancelled; })[0];
      hub.entities.publish({
        id: route.id, name: title,
        state: next ? next.departure : 'geen',
        attributes: { trips: res.trips, from: route.from, to: route.to, icon: 'mdi:train', attribution: 'NS Reisinformatie' }
      });
    } catch (e) {
      hub.warn(title + ': ' + e.message);
      var old = hub.entities.get(route.id);
      if (!old) hub.entities.publish({ id: route.id, name: title, state: 'unavailable', attributes: { reason: e.message, trips: [] } });
    }
  });
}

if (!routes().length) hub.warn('Nog geen trajecten ingesteld');
refresh();
setInterval(refresh, Math.max(30, Number(cfg.interval) || 90) * 1000);
