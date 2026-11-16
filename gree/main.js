// Gree-airco's (en merken op hetzelfde platform: Tosot, Cooper & Hunter, Sinclair…)
// lokaal via UDP-poort 7000. Geen cloud of account nodig: de airco geeft zijn
// eigen sleutel bij het koppelen. Levert per airco een `climate.<mac>`, dezelfde
// id die de Home Assistant-integratie gebruikt.

var cfg = hub.settings;
var GENERIC_KEY = 'a3K8Bx%2r8Y7#xDh';
// Nieuwere firmware (v2) versleutelt met AES-GCM en een andere standaardsleutel
var GCM_KEY = '{yxAHAY_Lm6pbC/<';
var GCM_IV = '5440784449675a516c5e6313';
var GCM_AAD = 'qualcomm-test';

var COLS = ['Pow', 'Mod', 'SetTem', 'WdSpd', 'Air', 'Blo', 'Health', 'SwhSlp', 'Lig', 'SwingLfRig', 'SwUpDn',
  'Quiet', 'Tur', 'StHt', 'TemUn', 'HeatCoolType', 'TemRec', 'SvSt', 'TemSen'];
var MODES = ['auto', 'cool', 'dry', 'fan_only', 'heat'];           // waarde van Mod
var FANS = ['auto', 'low', 'medium_low', 'medium', 'medium_high', 'high'];   // waarde van WdSpd

var devices = {};   // mac -> {mac, ip, name, key, gcm, id, failures, values}
var saved = hub.storage.get('devices', {});

function encrypt(obj, key, gcm) {
  var text = JSON.stringify(obj);
  if (gcm) {
    var r = hub.crypto.aes({ mode: 'gcm', key: key, iv: GCM_IV, aad: GCM_AAD, data: text });
    return { pack: r.data, tag: r.tag };
  }
  return { pack: hub.crypto.aes({ mode: 'ecb', key: key, data: text }) };
}

function decrypt(msg, key, gcm) {
  var text = gcm
    ? hub.crypto.aes({ mode: 'gcm', encrypt: false, key: key, iv: GCM_IV, aad: GCM_AAD, data: msg.pack, tag: msg.tag })
    : hub.crypto.aes({ mode: 'ecb', encrypt: false, key: key, data: msg.pack });
  // Sommige firmware vult aan met nul-bytes na de JSON
  return JSON.parse(text.substring(0, text.lastIndexOf('}') + 1));
}

function exchange(dev, payload, key, i) {
  var enc = encrypt(payload, key, dev.gcm);
  var msg = { cid: 'app', i: i, t: 'pack', uid: 0, tcid: dev.mac, pack: enc.pack };
  if (enc.tag) msg.tag = enc.tag;
  var replies = hub.udp.request({ host: dev.ip, port: 7000, data: JSON.stringify(msg), timeout: 3000 });
  if (!replies.length) throw new Error('geen antwoord');
  return decrypt(JSON.parse(replies[0].data), key, dev.gcm);
}

function scan() {
  var host = String(cfg.host || '').trim();
  var replies = [];
  try {
    replies = hub.udp.request({ host: host || '255.255.255.255', port: 7000, data: '{"t":"scan"}', timeout: 3000, maxReplies: host ? 1 : 0 });
  } catch (e) { hub.warn('Zoeken mislukt: ' + e.message); }
  replies.forEach(function (r) {
    try {
      var msg = JSON.parse(r.data);
      var gcm = !!msg.tag;
      var info = decrypt(msg, gcm ? GCM_KEY : GENERIC_KEY, gcm);
      var mac = info.mac || info.cid || msg.cid;
      if (!mac) return;
      var dev = devices[mac] || { mac: mac, failures: 0, values: null };
      dev.ip = r.host;
      if (dev.gcm === undefined) dev.gcm = gcm;
      dev.name = info.name && info.name !== mac ? info.name : 'Airco ' + mac.slice(-4);
      dev.id = 'climate.' + mac.toLowerCase();
      if (!dev.key && saved[mac]) { dev.key = saved[mac].key; dev.gcm = saved[mac].gcm; }
      devices[mac] = dev;
    } catch (e) { hub.warn('Onleesbaar antwoord van ' + r.host + ': ' + e.message); }
  });
  if (!Object.keys(devices).length) hub.warn('Geen airco gevonden' + (host ? ' op ' + host : '. Vul eventueel het IP-adres in.'));
}

// Koppelen: de airco geeft zijn eigen sleutel, versleuteld met de standaardsleutel
function bind(dev) {
  var res = null;
  // Nieuwere firmware antwoordt bij het zoeken nog met de oude versleuteling,
  // maar koppelt alleen via AES-GCM. Probeer daarom beide.
  var order = dev.gcm ? [true, false] : [false, true];
  for (var i = 0; i < order.length && !res; i++) {
    dev.gcm = order[i];
    try {
      res = exchange(dev, { mac: dev.mac, t: 'bind', uid: 0 }, dev.gcm ? GCM_KEY : GENERIC_KEY, 1);
    } catch (e) { res = null; }
  }
  if (!res) throw new Error('geen antwoord op koppelen');
  if (res.t !== 'bindok' || !res.key) throw new Error('koppelen geweigerd');
  dev.key = res.key;
  saved[dev.mac] = { key: dev.key, gcm: dev.gcm };
  hub.storage.set('devices', saved);
  hub.log(dev.name + ' gekoppeld');
}

function publish(dev) {
  var v = dev.values;
  var on = v.Pow === 1;
  var sensor = v.TemSen;
  // De meeste firmware meldt de kamertemperatuur met +40 (0 = geen sensor)
  var current = !sensor ? v.SetTem : (sensor >= 40 ? sensor - 40 : sensor);
  hub.entities.publish({
    id: dev.id, name: dev.name,
    state: on ? (MODES[v.Mod] || 'auto') : 'off',
    attributes: {
      current_temperature: current,
      temperature: v.SetTem,
      hvac_modes: ['off'].concat(MODES),
      fan_mode: FANS[v.WdSpd] || 'auto',
      fan_modes: FANS,
      min_temp: 16, max_temp: 30, target_temp_step: 1,
      temperature_unit: '°C',
      quiet: v.Quiet > 0, turbo: v.Tur === 1, light: v.Lig === 1,
      ip_address: dev.ip
    },
    services: ['set_hvac_mode', 'set_temperature', 'turn_on', 'turn_off', 'set_fan_mode']
  });
}

function refresh(dev) {
  if (!dev.key) bind(dev);
  var res;
  try {
    res = exchange(dev, { cols: COLS, mac: dev.mac, t: 'status' }, dev.key, 0);
  } catch (e) {
    // Sleutel kan veranderd zijn (airco gereset): één keer opnieuw koppelen
    bind(dev);
    res = exchange(dev, { cols: COLS, mac: dev.mac, t: 'status' }, dev.key, 0);
  }
  var values = {};
  (res.cols || []).forEach(function (c, i) { values[c] = res.dat[i]; });
  dev.values = values;
  dev.failures = 0;
  publish(dev);
}

function poll() {
  if (!Object.keys(devices).length) scan();
  Object.keys(devices).forEach(function (mac) {
    var dev = devices[mac];
    try { refresh(dev); } catch (e) {
      dev.failures++;
      if (dev.failures === 3) {
        hub.warn(dev.name + ' reageert niet: ' + e.message);
        hub.entities.publish({ id: dev.id, name: dev.name, state: 'unavailable', attributes: { reason: 'Airco reageert niet' } });
      }
      if (dev.failures % 10 === 0) scan();   // misschien een nieuw IP-adres gekregen
    }
  });
}

function command(dev, values) {
  var opt = Object.keys(values);
  var res = exchange(dev, { opt: opt, p: opt.map(function (k) { return values[k]; }), t: 'cmd' }, dev.key, 0);
  if (res.r !== 200) throw new Error('opdracht geweigerd (' + res.r + ')');
  if (dev.values) { opt.forEach(function (k) { dev.values[k] = values[k]; }); publish(dev); }
}

hub.onAction(function (entityId, service, data) {
  var dev = null;
  Object.keys(devices).forEach(function (mac) { if (devices[mac].id === entityId) dev = devices[mac]; });
  if (!dev) return hub.warn('Onbekende airco: ' + entityId);
  try {
    if (!dev.key) bind(dev);
    if (service === 'turn_off') command(dev, { Pow: 0 });
    else if (service === 'turn_on') command(dev, { Pow: 1 });
    else if (service === 'set_hvac_mode') {
      if (data.hvac_mode === 'off') command(dev, { Pow: 0 });
      else {
        var mode = MODES.indexOf(data.hvac_mode === 'heat_cool' ? 'auto' : data.hvac_mode);
        if (mode < 0) throw new Error('onbekende stand: ' + data.hvac_mode);
        command(dev, { Pow: 1, Mod: mode });
      }
    } else if (service === 'set_temperature') {
      var t = Math.max(16, Math.min(30, Math.round(Number(data.temperature))));
      command(dev, { TemUn: 0, SetTem: t });
    } else if (service === 'set_fan_mode') {
      var fan = FANS.indexOf(data.fan_mode);
      if (fan < 0) throw new Error('onbekende ventilatorstand: ' + data.fan_mode);
      command(dev, { WdSpd: fan, Quiet: 0, Tur: 0 });
    } else return hub.warn('Onbekende service: ' + service);
    setTimeout(function () { try { refresh(dev); } catch (e) { } }, 1500);
  } catch (e) {
    hub.warn(dev.name + ': ' + e.message);
  }
});

scan();
poll();
setInterval(poll, Math.max(5, Number(cfg.interval) || 15) * 1000);
