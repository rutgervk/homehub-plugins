// Weer: Open-Meteo (weerbericht) + Buienradar (neerslag komende 2 uur).
// Levert één entiteit `weather.thuis` in Home Assistant-stijl.

var ID = 'weather.thuis';

// WMO-weercode -> Home Assistant-conditie
var CONDITIONS = {
  0: 'sunny', 1: 'sunny', 2: 'partlycloudy', 3: 'cloudy', 45: 'fog', 48: 'fog',
  51: 'rainy', 53: 'rainy', 55: 'rainy', 56: 'rainy', 57: 'rainy',
  61: 'rainy', 63: 'rainy', 65: 'pouring', 66: 'rainy', 67: 'pouring',
  71: 'snowy', 73: 'snowy', 75: 'snowy', 77: 'snowy',
  80: 'rainy', 81: 'rainy', 82: 'pouring', 85: 'snowy', 86: 'snowy',
  95: 'lightning-rainy', 96: 'lightning-rainy', 99: 'lightning-rainy'
};

var weather = null;   // laatste geslaagde weerbericht (attributen)
var rain = [];        // [{time: 'HH:MM', mm: 0.0}]
var place = null;     // {name, lat, lon}

function resolvePlace() {
  var wanted = (hub.settings.place || '').trim();
  if (!wanted) {
    var info = hub.info;
    if (info.latitude === null) throw new Error('Geen locatie: vul een plaats in bij deze plugin of stel de locatie van de hub in');
    return { name: info.locationName || 'Thuis', lat: info.latitude, lon: info.longitude };
  }
  var cached = hub.storage.get('geo');
  if (cached && cached.query === wanted.toLowerCase()) return cached;
  var geo = hub.http.getJson('https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(wanted) + '&count=1&language=nl');
  if (!geo.results || !geo.results.length) throw new Error('Plaats "' + wanted + '" niet gevonden');
  var found = {
    query: wanted.toLowerCase(), name: geo.results[0].name || wanted,
    lat: geo.results[0].latitude, lon: geo.results[0].longitude
  };
  hub.storage.set('geo', found);
  return found;
}

function publish() {
  if (!weather) {
    hub.entities.publish({ id: ID, name: 'Weer', state: 'unavailable', attributes: {} });
    return;
  }
  var attrs = {};
  for (var k in weather.attributes) attrs[k] = weather.attributes[k];
  attrs.rain = rain;
  hub.entities.publish({ id: ID, name: 'Weer ' + place.name, state: weather.state, attributes: attrs });
}

function refreshWeather() {
  try {
    place = resolvePlace();
    var f = hub.http.getJson('https://api.open-meteo.com/v1/forecast?latitude=' + place.lat +
      '&longitude=' + place.lon +
      '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
      '&timezone=auto&forecast_days=6');
    var days = [];
    for (var i = 0; i < f.daily.time.length; i++) {
      days.push({
        datetime: f.daily.time[i],
        weather_code: f.daily.weather_code[i],
        condition: CONDITIONS[f.daily.weather_code[i]] || 'cloudy',
        temperature: f.daily.temperature_2m_max[i],
        templow: f.daily.temperature_2m_min[i]
      });
    }
    weather = {
      state: CONDITIONS[f.current.weather_code] || 'cloudy',
      attributes: {
        temperature: f.current.temperature_2m,
        temperature_unit: '°C',
        humidity: f.current.relative_humidity_2m,
        wind_speed: f.current.wind_speed_10m,
        wind_speed_unit: 'km/h',
        weather_code: f.current.weather_code,
        place: place.name,
        forecast: days,
        attribution: 'Open-Meteo / Buienradar'
      }
    };
  } catch (e) {
    hub.warn('Weer ophalen mislukt: ' + e.message);
  }
  publish();
}

function refreshRain() {
  if (!hub.settings.rain || !place) return;
  try {
    var r = hub.http.get('https://gpsgadget.buienradar.nl/data/raintext?lat=' +
      place.lat.toFixed(2) + '&lon=' + place.lon.toFixed(2));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var points = [];
    r.body.trim().split('\n').forEach(function (line) {
      var parts = line.trim().split('|');
      if (parts.length !== 2) return;
      var value = parseInt(parts[0], 10);
      if (isNaN(value)) return;
      // Buienradar-schaal: mm/u = 10^((waarde − 109) / 32), 0 = droog
      var mm = value <= 0 ? 0 : Math.pow(10, (value - 109) / 32);
      points.push({ time: parts[1], mm: Math.round(mm * 100) / 100 });
    });
    rain = points;
  } catch (e) {
    hub.warn('Buienradar ophalen mislukt: ' + e.message);
  }
  publish();
}

refreshWeather();
refreshRain();
setInterval(refreshWeather, 10 * 60 * 1000);
setInterval(refreshRain, 5 * 60 * 1000);
