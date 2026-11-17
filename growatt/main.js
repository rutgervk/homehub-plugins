// Growatt-zonnepanelen via de Growatt-cloud (ShinePhone-account van de gebruiker).
// Levert `sensor.growatt_vermogen` (W), `sensor.growatt_vandaag` (kWh) en
// `sensor.growatt_totaal` (kWh). De cloud ververst zelf maar eens per ~5 minuten;
// vaker opvragen heeft geen zin en kan het account tijdelijk blokkeren.
//
// Twee manieren van inloggen:
//  - gebruikersnaam + wachtwoord (dezelfde als in de ShinePhone-app), of
//  - een API-token (ShinePhone → Ik → instellingen → API-token), voor accounts
//    waar Growatt de wachtwoord-login voor apps van derden heeft dichtgezet.

var cfg = hub.settings;
var SERVER = String(cfg.server || 'https://openapi.growatt.com').replace(/\/+$/, '');
var AGENT = { 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; HomeHub)' };
var userId = null;

// Growatt gebruikt een eigen variant van MD5: een '0' op een even positie wordt 'c'
function hashPassword(password) {
  var h = hub.crypto.md5(password);
  var out = '';
  for (var i = 0; i < h.length; i++) out += (i % 2 === 0 && h.charAt(i) === '0') ? 'c' : h.charAt(i);
  return out;
}

// "1234.5 W" / "1.2 kW" / "8.4 kWh" / "1.1 MWh" -> getal in W of kWh
function number(text) {
  var m = /(-?[\d.]+)\s*([a-zA-Z]*)/.exec(String(text === undefined || text === null ? '' : text));
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  var unit = m[2].toLowerCase();
  if (unit === 'kw' || unit === 'mwh') v *= 1000;
  if (unit === 'wh') v /= 1000;
  return v;
}

function login() {
  var r = hub.http.request({
    method: 'POST', url: SERVER + '/newTwoLoginAPI.do', headers: AGENT,
    form: { userName: String(cfg.username || '').trim(), password: hashPassword(String(cfg.password || '')) }
  });
  if (r.status === 403) {
    var err = new Error('Growatt weigert inloggen met wachtwoord voor apps van derden (HTTP 403). ' +
      'Vul in de instellingen een API-token in (ShinePhone → Ik → instellingen → API-token).');
    err.blocked = true;
    throw err;
  }
  if (!r.ok) throw new Error('inloggen: HTTP ' + r.status);
  var back;
  try { back = r.json().back; } catch (e) { throw new Error('inloggen: onverwacht antwoord van Growatt'); }
  if (!back || !back.success) {
    throw new Error('inloggen geweigerd' + (back && (back.msg || back.error) ? ' (' + (back.msg || back.error) + ')' : '') +
      ' — controleer gebruikersnaam/wachtwoord, of gebruik een API-token');
  }
  userId = back.user && back.user.id;
  hub.log('Ingelogd bij Growatt');
}

function readClassic() {
  if (!userId) login();
  var r = hub.http.request({ url: SERVER + '/PlantListAPI.do?userId=' + userId, headers: AGENT, followRedirects: false });
  var back = null;
  try { back = r.json().back; } catch (e) { }
  if (!r.ok || !back) {
    // Sessie verlopen: opnieuw inloggen en nog één keer proberen
    login();
    r = hub.http.request({ url: SERVER + '/PlantListAPI.do?userId=' + userId, headers: AGENT, followRedirects: false });
    back = r.json().back;
  }
  var total = back.totalData || {};
  var plants = back.data || [];
  var power = number(total.currentPowerSum), today = number(total.todayEnergySum), all = number(total.totalEnergySum);
  if (power === null) {
    power = 0; today = 0; all = 0;
    plants.forEach(function (p) {
      power += number(p.currentPower) || 0; today += number(p.todayEnergy) || 0; all += number(p.totalEnergy) || 0;
    });
  }
  return { power: power, today: today, total: all, plants: plants.map(function (p) { return p.plantName; }) };
}

function readToken() {
  var headers = { token: String(cfg.token).trim() };
  var list = hub.http.getJson(SERVER + '/v1/plant/list', headers);
  if (list.error_code) throw new Error('API-token geweigerd (' + (list.error_msg || list.error_code) + ')');
  var plants = (list.data && list.data.plants) || [];
  var power = 0, today = 0, total = 0;
  plants.forEach(function (p) {
    var d = hub.http.getJson(SERVER + '/v1/plant/data?plant_id=' + p.plant_id, headers).data || {};
    power += Number(d.current_power) || 0;
    today += Number(d.today_energy) || 0;
    total += Number(d.total_energy) || 0;
  });
  return { power: power, today: today, total: total, plants: plants.map(function (p) { return p.name; }) };
}

function sensor(id, name, value, unit, deviceClass, stateClass, extra) {
  var attrs = { unit_of_measurement: unit, device_class: deviceClass, state_class: stateClass, attribution: 'Growatt' };
  for (var k in (extra || {})) attrs[k] = extra[k];
  hub.entities.publish({ id: id, name: name, state: value === null ? 'unavailable' : Math.round(value * 100) / 100, attributes: attrs });
}

var failures = 0;
var blocked = false; // wachtwoord-login dichtgezet: niet elke paar minuten opnieuw proberen
function refresh() {
  var data;
  if (blocked) return;
  try {
    if (String(cfg.token || '').trim()) data = readToken();
    else if (cfg.username && cfg.password) data = readClassic();
    else { hub.warn('Vul gebruikersnaam en wachtwoord (of een API-token) van Growatt in'); return; }
    failures = 0;
  } catch (e) {
    failures++;
    userId = null;
    if (e.blocked) {
      blocked = true;
      hub.warn(e.message);
      sensor('sensor.growatt_vermogen', 'Zonvermogen', null, 'W', 'power', 'measurement');
      return;
    }
    // Eerste paar keer melden, daarna nog maar eens per ~uur om het logboek niet vol te schrijven
    if (failures <= 3 || failures % 12 === 0) hub.warn('Growatt uitlezen mislukt (' + failures + 'x): ' + e.message);
    if (failures >= 3) {
      sensor('sensor.growatt_vermogen', 'Zonvermogen', null, 'W', 'power', 'measurement');
    }
    return;
  }
  var extra = { plants: data.plants };
  sensor('sensor.growatt_vermogen', 'Zonvermogen', data.power, 'W', 'power', 'measurement', extra);
  sensor('sensor.growatt_vandaag', 'Zonne-energie vandaag', data.today, 'kWh', 'energy', 'total_increasing');
  sensor('sensor.growatt_totaal', 'Zonne-energie totaal', data.total, 'kWh', 'energy', 'total_increasing');
}

refresh();
setInterval(refresh, Math.max(1, Number(cfg.interval) || 5) * 60 * 1000);
