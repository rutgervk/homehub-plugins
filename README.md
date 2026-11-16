# HomeHub-plugins

De plugin-catalogus van [HomeHub](https://github.com/rutgervk/HomeHub), het wanddashboard dat zonder
server werkt. De app leest `index.json` uit deze repo en installeert een plugin met één tik.

| Plugin | Wat | Verbinding |
|---|---|---|
| `weather` | Weerbericht en buienverwachting | Open-Meteo + Buienradar, geen account |
| `ns` | Treinreizen per traject, met overstappen | NS-reisplanner, gratis API-key |
| `sonos` | Sonos-spelers: bediening, volume, favorieten | lokaal (UPnP/SOAP) |
| `motionblinds` | Zonneschermen/rolluiken van Motionblinds-merken (Brel…) | lokaal (UDP), sleutel uit de app |
| `gree` | Airco's van Gree en verwante merken | lokaal (UDP) |
| `growatt` | Zonnepanelen: vermogen en opbrengst | Growatt-cloud, eigen account |
| `ha_bridge` | Neemt entiteiten van een bestaande Home Assistant-server over | lokaal (REST) |

## Opbouw

```
index.json              lijst van plugins (gegenereerd met tools/build_index.py in de HomeHub-repo)
<id>/manifest.json      naam, versie, instelvelden, rechten
<id>/main.js            het script (draait afgeschermd in de app)
```

Een plugin bevat nooit wachtwoorden of sleutels: die vult de gebruiker in de app in en ze blijven op
de tablet. Hoe je zelf een plugin schrijft staat in `docs/PLUGINS.md` van de HomeHub-repo.

Deze repo is een kopie van de map `catalog/` uit de HomeHub-repo; wijzigingen worden daar gemaakt.
