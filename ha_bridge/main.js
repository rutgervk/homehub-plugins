// Home Assistant-brug: spiegelt entiteiten van een bestaande Home Assistant-server
// naar de hub en stuurt services door. Zo werkt alles wat HA al kan (Tuya, Ring,
// HACS-integraties…) direct in HomeHub, zolang die server draait. Installeer je
// later een eigen plugin die dezelfde entiteit-id levert, dan wint die plugin.

var cfg = hub.settings;
var BASE = String(cfg.url || '').trim().replace(/\/+$/, '');
var HEADERS = { 'Authorization': 'Bearer ' + String(cfg.token || '').trim() };

var SERVICES = {
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
  climate: ['set_hvac_mode', 'set_temperature', 'turn_on', 'turn_off', 'set_fan_mode'],
  media_player: ['media_play', 'media_pause', 'media_play_pause', 'media_next_track', 'media_previous_track',
    'volume_set', 'volume_mute', 'select_source', 'turn_on', 'turn_off'],
  todo: ['add_item', 'update_item', 'remove_item', 'remove_completed_items'],
  scene: ['turn_on'], script: ['turn_on'], button: ['press'], input_button: ['press'],
  lock: ['lock', 'unlock'], vacuum: ['start', 'stop', 'return_to_base']
};

function list(text) {
  return String(text || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}
var include = list(cfg.include), exclude = list(cfg.exclude);

// Een patroon is een domein ("light"), een volledige id, of een begin met * ("sensor.growatt*")
function matches(id, patterns) {
  var domain = id.split('.')[0];
  return patterns.some(function (p) {
    if (p.indexOf('.') < 0) return p === domain;
    if (p.charAt(p.length - 1) === '*') return id.indexOf(p.slice(0, -1)) === 0;
    return p === id;
  });
}
function wanted(id) {
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id)) return false;
  return (!include.length || matches(id, include)) && !matches(id, exclude);
}

var seen = {};        // id -> last_updated zoals HA die meldde
var todoItems = {};   // id -> items
var failures = 0;

function publish(s) {
  var attrs = s.attributes || {};
  var domain = s.entity_id.split('.')[0];
  var name = attrs.friendly_name || s.entity_id;
  var copy = {};
  for (var k in attrs) if (k !== 'friendly_name') copy[k] = attrs[k];
  if (typeof copy.entity_picture === 'string' && copy.entity_picture.charAt(0) === '/') {
    copy.entity_picture = BASE + copy.entity_picture;
  }
  if (domain === 'todo') copy.items = todoItems[s.entity_id] || [];
  hub.entities.publish({ id: s.entity_id, name: name, state: s.state, attributes: copy, services: SERVICES[domain] || [] });
}

function refreshTodo(id) {
  try {
    var r = hub.http.request({
      method: 'POST', url: BASE + '/api/services/todo/get_items?return_response',
      headers: HEADERS, json: { entity_id: id }
    });
    if (!r.ok) return;
    var data = r.json().service_response || {};
    todoItems[id] = (data[id] && data[id].items) || [];
  } catch (e) { }
}

var tick = 0;
function poll() {
  tick++;
  if (!BASE || !cfg.token) return;
  var r;
  try {
    r = hub.http.request({ url: BASE + '/api/states', headers: HEADERS, timeout: 8000 });
    if (r.status === 401) throw new Error('token geweigerd');
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    failures++;
    if (failures === 1 || failures % 20 === 0) hub.warn('Home Assistant niet bereikbaar: ' + e.message);
    if (failures === 3) {
      // Server weg: laat de kaarten 'niet beschikbaar' tonen in plaats van oude waarden
      Object.keys(seen).forEach(function (id) { hub.entities.update(id, { state: 'unavailable' }); });
      seen = {};
    }
    return;
  }
  if (failures > 0) hub.log('Home Assistant weer bereikbaar');
  failures = 0;
  var now = {};
  r.json().forEach(function (s) {
    if (!wanted(s.entity_id)) return;
    now[s.entity_id] = true;
    var isTodo = s.entity_id.indexOf('todo.') === 0;
    if (isTodo && (tick % 6 === 1 || !todoItems[s.entity_id])) { refreshTodo(s.entity_id); seen[s.entity_id] = null; }
    if (seen[s.entity_id] === s.last_updated) return;
    seen[s.entity_id] = s.last_updated;
    publish(s);
  });
  Object.keys(seen).forEach(function (id) {
    if (!now[id]) { delete seen[id]; hub.entities.remove(id); }
  });
}

hub.onAction(function (entityId, service, data) {
  var domain = entityId.split('.')[0];
  var body = { entity_id: entityId };
  for (var k in data) body[k] = data[k];
  var r = hub.http.request({ method: 'POST', url: BASE + '/api/services/' + domain + '/' + service, headers: HEADERS, json: body });
  if (!r.ok) hub.warn(entityId + ' ' + service + ': HTTP ' + r.status + ' ' + r.body.substr(0, 200));
  if (domain === 'todo') { refreshTodo(entityId); seen[entityId] = null; }
  setTimeout(poll, 700);
});

if (!BASE || !cfg.token) hub.warn('Vul het adres en een long-lived access token van Home Assistant in');
poll();
setInterval(poll, Math.max(2, Number(cfg.interval) || 5) * 1000);
