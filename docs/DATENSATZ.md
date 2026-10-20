# Datensatz: Live-Betrieb S-Bahn und U-Bahn Berlin

Dieses Dokument beschreibt den Recorder `scripts/record.mjs`, die Rohdaten unter `recordings/` und den Export `scripts/export.mjs`. Es richtet sich an alle, die mit den Daten ein Modell trainieren oder auswerten.

## 1. Zweck

Der Datensatz soll ein Modell in die Lage versetzen, Dispositionsmaßnahmen zu empfehlen: Halten, Kurzwenden, Ausfallen lassen, Zusatzfahrten, Gleiswechsel, Taktregulierung und den Umgang mit Störungen. Ziel ist ein Betrieb, der pünktlicher, gleichmäßiger und sicherer läuft.

Die Zugsicherung (Signale, Fahrstraßen, Abstände) bleibt vollständig außerhalb. Das Modell gibt nur Empfehlungen für die Disposition; es steuert nichts. Die „Sicherheit“ in den Kennzahlen meint betriebliche Proxys wie liegengebliebene Züge, überfüllte Bahnsteige nach Taktlücken und Pulkbildung. Für Empfehlungen, die mit der Infrastruktur verträglich sind, liefert der Export beobachtete Wendebahnhöfe und Mindestabstände (Abschnitt 8, `network.turnStations`, `network.minHeadways`).

Aufgezeichnet wird, was öffentlich sichtbar ist: Soll-Fahrplan, Prognosen, tatsächliche Zeiten, Ausfälle, Gleise, Hinweise, geschätzte Positionen und Kontext (Wetter, Unwetterwarnungen, Ferien). Interne Daten der Betreiber (Stellwerk, Fahrzeugumläufe, Personal) sind nicht enthalten. Maßnahmen der Disposition werden daher aus ihren sichtbaren Folgen abgeleitet (Abschnitt 9).

## 2. Quellen und Abdeckung

| Quelle | Inhalt | Intervall | Anfragen |
|---|---|---|---|
| BVG-HAFAS über `v6.bvg.transport.rest` | Radar, laufende Fahrten, Abfahrtstafeln, Fahrtverläufe, Soll-Fahrplan | 30 s bis 30 min | im Budget (Standard 45/min) |
| Open-Meteo | Wetter an 5 Punkten, aktuell und 15-min-Vorhersage | 15 min | außerhalb des Budgets |
| DWD-Warnungen über Bright Sky | amtliche Unwetterwarnungen für Berlin-Mitte | 15 min | außerhalb |
| OpenHolidays | Feiertage und Schulferien Berlin (DE-BE), ganzes Jahr | täglich, bei Fehlern höchstens alle 30 min ein neuer Versuch | außerhalb |
| VBB-GTFS (optional, `--gtfs`) | statischer Fahrplan als ZIP-Archiv | wöchentlich, nur bei Änderung; nach einem Fehler neuer Versuch nach 1 h | außerhalb |

Abgedeckt sind alle 25 Linien aus `public/data/network.json` (S1, S15, S2, S25, S26, S3, S41, S42, S46, S47, S5, S7, S75, S8, S85, S9, U1 bis U9) mit 310 Bahnhöfen. Zusätzlich landen alle anderen Züge der Produkte `suburban` und `subway` im Berliner Raum in den Rohdaten, zum Beispiel Verstärker oder die Sonderfahrten mit der Linienbezeichnung `1`. Schienenersatzverkehr (SEV) wird erfasst, wenn ein Bus einer S- oder U-Bahn-Linie im Radar erscheint (Linien-ID mit `s-bahn`/`u-bahn` oder Linienname `S…`/`U…`, dazu `ev`, `sev` oder `ersatz` in Linie oder Richtung). Ersatzbusse für Straßenbahnen werden nicht erfasst. S-Bahnen anderer Netze (Rostock, Dresden, Mitteldeutschland), die HAFAS bei `query=*` mitliefert, werden über die Position (außerhalb 52,2–52,9 N, 12,8–14,1 O) und beim Soll-Fahrplan über die Linien-ID (`de-vbb-…`) verworfen.

## 3. Recorder starten

Voraussetzung ist Node 26 oder neuer. Es gibt keine npm-Abhängigkeiten.

```bash
node scripts/record.mjs                         # recordings/, Budget 45 Anfragen/min, unbegrenzt
node scripts/record.mjs --budget 35 --minutes 60
node scripts/record.mjs --budget=35             # beide Schreibweisen gehen
REC_DIR=/srv/rec REC_BUDGET=45 node scripts/record.mjs
```

| Flag | Umgebungsvariable | Standard | Bedeutung |
|---|---|---|---|
| `--dir` | `REC_DIR` | `recordings` im Projekt | Ausgabeverzeichnis |
| `--budget` | `REC_BUDGET` | `45` | BVG-Anfragen pro Minute, Zahl > 0 |
| `--api` | `REC_API` | `https://v6.bvg.transport.rest` | API-Basis |
| `--network` | `REC_NETWORK` | `public/data/network.json` | Liniennetz |
| `--minutes` | `REC_MINUTES` | `0` (unbegrenzt) | Laufzeit, danach sauberes Ende |
| `--key` | `REC_KEY` | leer | weitere Schlüsselbahnhöfe, Komma-getrennte IDs |
| `--gtfs` | `REC_GTFS=1` | aus | wöchentlicher GTFS-Download |
| `--no-context` | `REC_CONTEXT=0` | Kontext an | Wetter, Warnungen und Ferien abschalten |

Unbekannte Flags (Tippfehler) und ungültige Werte für `--budget` oder `--minutes` beenden den Recorder sofort mit einer Meldung, statt still ohne Anfragen weiterzulaufen.

Der Recorder schreibt jede Minute eine Statuszeile, zum Beispiel:

```
2026-10-20 01:53  30 req/min (radar 2, running 1, plan 5, trip 3, board 19)  radar 1  running 1  tracked 1482  end due 0  queue 143  budget 30  errors 0
```

Die Raten sind auf eine Minute normiert, auch wenn zwischen zwei Zeilen wegen Schlafmodus mehr Zeit lag.

**Nur ein Recorder je Verzeichnis.** Beim Start legt der Recorder `recordings/lock` mit seiner Prozess-ID an und erneuert die Datei jede Minute. Läuft schon ein Recorder auf demselben Verzeichnis (Prozess lebt und `lock` wurde in den letzten 3 Minuten erneuert), bricht ein zweiter mit einer Meldung ab. Ein veraltetes `lock` nach Absturz oder Neustart des Rechners wird übernommen. Merkt ein laufender Recorder, dass ein anderer das Verzeichnis übernommen hat, beendet er sich, ohne `state.json` zu überschreiben. So können zwei Prozesse weder dieselben Dateien beschreiben noch zusammen das gemeinsame Limit von 100 Anfragen pro Minute sprengen.

**Laptop.** Schlafmodus, Netzverlust und Neustarts sind vorgesehen. Der Zustand liegt in `recordings/state.json` (nachts rund 2,5 MB, nach dem 14-Uhr-Planlauf bis etwa 4 MB) und wird jede Minute und beim Beenden geschrieben (temporäre Datei, fsync, Umbenennen). Nach einem Neustart läuft die Aufzeichnung dort weiter, wo sie stand: Fahrten, die schon abgeschlossen sind, werden nicht erneut abgefragt, Tafeln nicht sofort erneut geladen, unveränderte Tafelzeilen werden nicht doppelt geschrieben, und Planfenster, deren Anfrage beim Beenden noch lief, werden nachgeholt. Bricht das Netz weg (Netzfehler ohne Antwort, etwa direkt nach dem Aufwachen, bevor WLAN und DNS wieder stehen), pausiert der Recorder alle Fahrt- und Planabfragen, bis wieder eine Antwort kommt; Radar und Tafeln prüfen in der Zeit weiter die Verbindung. Solche Fehlschläge verbrauchen weder Wiederholungen noch die Nachholabfrage. Beenden mit Ctrl-C, `kill -TERM` oder durch Schließen des Terminals (SIGHUP); in allen drei Fällen werden Zustand und `stop`-Eintrag geschrieben. Damit der Mac nicht einschläft und Endabfragen verpasst, startet man den Recorder am besten so:

```bash
caffeinate -i node scripts/record.mjs
```

**Server.** Gleiches Verhalten unter systemd oder pm2:

```ini
[Service]
WorkingDirectory=/srv/u-s-bahn
ExecStart=/usr/bin/node scripts/record.mjs --dir /srv/rec --budget 45
Restart=always
KillSignal=SIGTERM
```

```bash
pm2 start scripts/record.mjs --name rec -- --dir /srv/rec --budget 45
```

**Budget.** Die BVG-Schnittstelle erlaubt 100 Anfragen pro Minute und IP, geteilt mit allem auf derselben Maschine (die Karte selbst braucht etwa 10 bis 15). Der Recorder hält sein Budget mit einem Token-Bucket ein (Kapazität 3, höchstens 3 Anfragen gleichzeitig, 15 s Timeout). Bei HTTP 429 halbiert er das Budget für 5 Minuten und beachtet `Retry-After`. Reicht das Budget nicht für alles, gilt diese Rangfolge:

1. Radar (alle 30 s)
2. Fahrtende-Abfragen (`trip end`)
3. laufende Fahrten (alle 60 s)
4. Störungsfahrten und Erstabfragen (`trip live`/`first`, zusammen höchstens 4/min)
5. Fahrtmitte (`trip mid`, höchstens 8/min)
6. Soll-Fahrplan (`plan`, höchstens 5/min)
7. Nachholabfragen (`trip late`, höchstens 2/min)
8. Tafeln, alle in einem gemeinsamen Pool

Für die Tafeln gilt ein Zielabstand: Schlüsselbahnhöfe alle 4 min (nachts 01–04 Uhr alle 8 min), übrige alle 15 min (nachts 30 min). Jede freie Anfrage geht an die Tafel, deren Alter im Verhältnis zum Zielabstand am größten ist (mindestens 1). Reicht das Budget nicht, strecken sich alle Tafeln im gleichen Verhältnis, statt dass die übrigen Bahnhöfe ganz leer ausgehen. Schlüsselbahnhöfe sind alle Linienendpunkte und alle Bahnhöfe mit mindestens drei Linien, ergänzt um `--key`; das sind 88 Bahnhöfe mit 89 HAFAS-IDs, insgesamt werden 311 IDs abgefragt. Rechnerisch bleiben bei Budget 45 tagsüber nach Radar, Fahrten und Mitte rund 31 Anfragen pro Minute für Tafeln; der Bedarf liegt bei 37. Schlüsselbahnhöfe kommen dann etwa alle 5 min, die übrigen etwa alle 18 min dran, während eines Planlaufs (zweimal täglich rund 35 min mit 5 Anfragen/min) alle 6 bzw. 21 min. Bei Budget 30 strecken sich beide Abstände auf etwa das Zwei- bis Dreifache.

**Speicherbedarf.** Rund 70 MB pro Tag (gzip), gut 2 GB pro Monat; Messwerte in Abschnitt 4.4.

### 3.1 Skripte

| Skript | Zweck |
|---|---|
| `scripts/record.mjs` | Dauerhafte Aufzeichnung in `recordings/` |
| `scripts/export.mjs` | Export eines oder mehrerer Betriebstage als JSON für das Training |

Beide sind in `package.json` eingetragen: `npm run record -- --budget 45` und `npm run export -- --from 2026-10-20 --to 2026-10-26 --gzip`.

## 4. Rohdaten

### 4.1 Verzeichnisse

```
recordings/
  lock                                    Prozess-ID des laufenden Recorders
  state.json                              Zustand des Recorders (Neustart)
  v1/2026-10-19/21Z.radar.ndjson          laufende UTC-Stunde, wird angehängt
  v1/2026-10-19/20Z.radar.ndjson.gz       abgeschlossene Stunden, gzip
  v1/static/network-8deaeb499b6a.json     Kopie jeder Netzversion (sha256, 12 Zeichen)
  v1/static/gtfs-2026-10-19.zip           nur mit --gtfs
  v1/manifest.ndjson                      eine Zeile je komprimierte Datei
```

Datum und Stunde im Pfad sind UTC und beziehen sich auf den Zeitpunkt des Schreibens. Eine Zeile kann deshalb ein `ms` haben, das bis zu 15 s vor dem Stundenbeginn liegt.

Beim Stundenwechsel wird jede Datei der alten Stunde komprimiert: erst vollständig nach `.gz.tmp` schreiben und mit fsync sichern, dann die Klartextdatei löschen, `.gz.tmp` in `.gz` umbenennen und eine Manifestzeile `{path, rows, bytes, sha256, firstMs, lastMs}` anhängen (`bytes` und `sha256` beziehen sich auf die `.gz`-Datei, `rows` auf ihre Zeilen). Beim Start werden halbe letzte Zeilen abgeschnitten und verwaiste `.gz.tmp` aufgeräumt: Existiert die Klartextdatei noch, wird `.gz.tmp` verworfen und neu komprimiert; sonst ist `.gz.tmp` vollständig und wird umbenannt. So geht bei einem Absturz an keiner Stelle etwas verloren, und keine Zeile landet doppelt. Liegengebliebene Dateien früherer Stunden werden ebenfalls komprimiert.

Mehrere gzip-Abschnitte hintereinander in einer Datei sind gültig. Das kommt nur vor, wenn nach einem Uhrensprung erneut in eine alte Stunde geschrieben wurde; dann bekommt dieselbe Datei eine zweite Manifestzeile mit den neuen Gesamtwerten. **Es gilt immer die letzte Manifestzeile je Pfad.**

### 4.2 Gemeinsame Felder

Jede Zeile ist ein JSON-Objekt mit diesem Kopf:

| Feld | Einheit | Bedeutung |
|---|---|---|
| `v` | – | Formatversion, derzeit `1` |
| `stream` | – | Name des Streams |
| `ms` | ms seit 1970 (UTC) | Beginn der Anfrage; bei `log`, `dict`, `static` der Schreibzeitpunkt |
| `latMs` | ms | Dauer der Anfrage, `null` ohne Anfrage |
| `status` | – | HTTP-Status; `null` ohne Anfrage |

Geschrieben werden nur Antworten mit Status 200 oder 404 (404 bedeutet bei HAFAS „nichts gefunden“, etwa eine Linie ohne Fahrten im Zeitfenster oder eine Fahrt, die HAFAS nicht mehr kennt). Fehlgeschlagene Anfragen tauchen nur in der Health-Statistik auf.

Zeiten innerhalb der API-Objekte bleiben ISO-Zeichenketten mit Offset, genau wie geliefert (`2026-10-19T23:24:00+02:00`). Verspätungen sind Sekunden. `null` heißt unbekannt und wird nie als 0 geschrieben.

**LineRef** (in vielen Streams eingebettet):

| Feld | Bedeutung |
|---|---|
| `line` | Linienname, z. B. `S1`, `U8`, `1` |
| `lineId` | HAFAS-Linienvariante, z. B. `de-vbb-11000000-s-bahn-s1-s1-pi` |
| `fahrtNr` | Zugnummer, kann `null` sein |
| `product` | `suburban`, `subway` oder `bus` (nur SEV) |
| `operator` | Betreiber-ID, z. B. `s-bahn-berlin-gmbh`, `berliner-verkehrsbetriebe` |

**SO** (Halt, in `radar.next` und `trip.stopovers`):

| Feld | Einheit | Bedeutung |
|---|---|---|
| `stop` | – | HAFAS-Halt-ID |
| `cancelled` | bool | Ankunft **oder** Abfahrt an diesem Halt fällt aus (siehe unten) |
| `plannedArrival`, `arrival` | ISO | Soll- und Ist/Prognose-Ankunft |
| `arrivalDelay` | s | Verspätung Ankunft, `null` ohne Echtzeit |
| `plannedArrivalPlatform`, `arrivalPlatform` | – | Soll- und Ist-Gleis Ankunft |
| `arrivalPrognosisType` | – | z. B. `prognosed`, `null` |
| `plannedDeparture`, `departure`, `departureDelay`, `plannedDeparturePlatform`, `departurePlatform`, `departurePrognosisType` | wie oben | Abfahrt |
| `occupancy` | – | `low`, `medium`, `high` oder `null` |
| `remarks` | – | Liste von Hinweis-Hashes, Text in `dict` |

`cancelled` folgt der Logik von HAFAS: Es ist `true`, sobald Ankunft oder Abfahrt entfällt, und die entfallene Zeit ist dann `null`. Ein Halt mit `cancelled: true` und gesetzter `arrival` ist also der letzte bediente Halt einer vorzeitig endenden Fahrt (der Zug kommt an, fährt aber nicht weiter); mit gesetzter `departure` ist es der erste bediente Halt einer später beginnenden Fahrt. Erst wenn beide Zeiten fehlen, fällt der Halt ganz aus. Der Export trennt das in `arrCancelled`, `depCancelled` und `cancelled` (Abschnitt 8). `prognosisType` ist kein verlässliches Echtzeit-Merkmal; HAFAS liefert `prognosed` auch dann noch, wenn die Verspätung schon wieder `null` ist.

Hinweis-Hash: sha1 über `type|code|summary|text`, die ersten 12 Hex-Zeichen.

### 4.3 Streams

| Stream | Anfrage | Intervall | Inhalt |
|---|---|---|---|
| `radar` | `/radar` über 52,29–52,76 N, 13,06–13,91 O | 30 s | alle S-/U-Züge und SEV-Busse mit Position und nächsten Halten |
| `running` | `/trips?query=*&onlyCurrentlyRunning=true` | 60 s | alle laufenden S-/U-Fahrten mit Position, auch der Ring |
| `board` | `/stops/{id}/departures` | Ziel 4 bzw. 15 min | Abfahrtstafeln, nur geänderte Zeilen |
| `trip` | `/trips/{id}` | ereignisgesteuert | vollständiger Fahrtverlauf |
| `plan` | `/trips?query=<Linie>&fromWhen&untilWhen` | 02:30 und 14:00 | Soll-Fahrten der nächsten 24 h |
| `dict` | – | beim ersten Auftreten | Halte und Hinweistexte |
| `context` | Open-Meteo, Bright Sky, OpenHolidays | 15 min / täglich | Wetter, Warnungen, Kalender |
| `static` | – | Start und täglich | Prüfsummen der Netzdateien |
| `log` | – | laufend | Start, Stopp, Lücken, Fehler, Health |

**radar**

```json
{"v":1,"stream":"radar","ms":1792445385444,"latMs":1732,"status":200,"rt":1792445347,"total":654,
 "trains":[{"tripId":"1|84990|0|86|19102026","line":"1","lineId":"1","fahrtNr":null,"product":"suburban","operator":null,
   "direction":"S Wannsee Bhf (Berlin)","lat":52.486729,"lon":13.361431,"next":[{"stop":"900057102","cancelled":false,
   "plannedArrival":"2026-10-19T23:24:00+02:00","arrival":"2026-10-19T23:29:00+02:00","arrivalDelay":300, "…":"…"}]}]}
```

| Feld | Einheit | Bedeutung |
|---|---|---|
| `rt` | s seit 1970 | `realtimeDataUpdatedAt` des Servers |
| `total` | Anzahl | alle Fahrzeuge der Antwort vor dem Filter (auch Bus, Tram, Regio) |
| `trains[]` | – | `tripId`, LineRef, `direction` (Zieltext), `lat`/`lon` (Grad, WGS84), `next` (Liste SO, in der Regel 4 Einträge; der letzte ist das Fahrtziel) |

Die Position ist eine Schätzung von HAFAS aus Fahrplan und Echtzeit, kein GPS. Der Server rechnet sie bei jeder Abfrage neu, darum wird jeder Schnappschuss gespeichert. Der S-Bahn-Ring (S41, S42) erscheint im Radar nur teilweise und unregelmäßig (im Testlauf in 63 von 160 Schnappschüssen, höchstens 5 Züge gleichzeitig, während `running` rund 18 zeigt); vollständig ist er nur in `running`.

**running**

```json
{"v":1,"stream":"running","ms":1792445418502,"latMs":296,"status":200,"rt":1792445377,
 "trains":[{"tripId":"1|81134|0|86|19102026","line":"S41","lineId":"de-vbb-11000000-s-bahn-s41-s41-a","fahrtNr":"1564",
   "product":"suburban","operator":"s-bahn-berlin-gmbh","direction":null,"origin":"900020202","destination":"900007102",
   "plannedDeparture":"2026-10-19T23:28:00+02:00","plannedArrival":"2026-10-20T01:34:00+02:00","lat":52.536664,"lon":13.348433}]}
```

`origin`/`destination` sind HAFAS-Halt-IDs, `plannedDeparture`/`plannedArrival` Soll-Zeiten an Start und Ziel, `lat`/`lon` die geschätzte Position. Diese Liste enthält keine Verspätungen.

**board**

```json
{"v":1,"stream":"board","ms":1792445279272,"latMs":99,"status":200,"stop":"900023201","duration":30,"total":23,
 "rows":[{"tripId":"1|54357|5|86|19102026","line":"U2","lineId":"de-vbb-11000000-u-bahn-u2","fahrtNr":"6196","product":"subway",
   "operator":"berliner-verkehrsbetriebe","direction":"Pankow","destination":"900130002","plannedWhen":"2026-10-19T23:28:00+02:00",
   "when":"2026-10-19T23:28:00+02:00","delay":0,"plannedPlatform":"2 (U2)","platform":"2 (U2)","prognosisType":"prognosed",
   "cancelled":false,"occupancy":"low","remarks":["b7dfdba4cfc1"]}]}
```

| Feld | Einheit | Bedeutung |
|---|---|---|
| `stop` | – | abgefragte HAFAS-ID |
| `duration` | min | Zeitfenster der Tafel (30 an Schlüsselbahnhöfen, sonst 45) |
| `total` | Anzahl | Abfahrten in der Antwort |
| `rows[]` | – | nur Zeilen, deren `when`, `delay`, `platform`, `cancelled`, `prognosisType`, `occupancy`, `remarks` oder `direction` sich seit der letzten geschriebenen Zeile für dieselbe Kombination aus Fahrt und Halt geändert haben |
| `rows[].stop` | – | nur vorhanden, wenn der Halt der Abfahrt von der abgefragten ID abweicht |
| `plannedWhen`, `when`, `delay` | ISO, ISO, s | Soll-Abfahrt, Prognose, Verspätung |
| `cancelled` | bool | die **Abfahrt** an diesem Halt entfällt |
| `destination` | – | HAFAS-ID des Ziels |

Eine fehlende Zeile in einer späteren Tafel heißt also „unverändert“ oder „nicht mehr auf der Tafel“, nicht „entfallen“. Ein Tafeleintrag ohne Zeilen ist trotzdem ein Nachweis, dass die Tafel abgefragt wurde. Gleisangaben schreibt HAFAS je nach Abfrage unterschiedlich (`1 (U1/U3)` auf der Tafel, `1 (U1/U3` im Fahrtverlauf); der Export vergleicht Gleise deshalb nur über die führende Gleisnummer.

**trip**

```json
{"v":1,"stream":"trip","ms":1792445236206,"latMs":105,"status":200,"reason":"end","tripId":"1|1882|1|86|19102026",
 "trip":{"id":"1|1882|1|86|19102026","line":"S5","lineId":"de-vbb-11000000-s-bahn-s5-s5-e","fahrtNr":"22513","product":"suburban",
   "operator":"s-bahn-berlin-gmbh","direction":"S Westkreuz (Berlin)","origin":"900320004","destination":"900024102",
   "plannedDeparture":"2026-10-19T22:21:00+02:00","departure":"2026-10-19T22:21:00+02:00","departureDelay":0,
   "plannedArrival":"2026-10-19T23:27:00+02:00","arrival":"2026-10-19T23:27:00+02:00","arrivalDelay":0,
   "cancelled":false,"occupancy":null,"remarks":["b7dfdba4cfc1"],"stopovers":[{"stop":"900320004","…":"…"}]}}
```

`trip.cancelled` ist bei HAFAS auch bei Teilausfällen `true`; ob eine Fahrt ganz ausfällt, ergibt sich nur aus den Halten.

`reason` sagt, warum die Fahrt abgefragt wurde:

| reason | Zeitpunkt | Zweck |
|---|---|---|
| `end` | 90 s vor der erwarteten Ankunft am Ziel | Ist-Zeiten der letzten Halte sichern, solange HAFAS sie noch hat. Liegt die Ankunft dann noch mehr als 150 s in der Zukunft, folgt eine weitere Abfrage; höchstens 3 je Fahrt. Bei HTTP-Fehlern oder Timeout zwei Wiederholungen nach 2 und 8 s, danach `late`. Netzfehler ohne Antwort zählen nicht als Versuch |
| `mid` | bei Fahrten ab 60 min Soll-Fahrzeit 50 min nach Fahrtbeginn und danach spätestens alle 50 min nach der letzten erfolgreichen Abfrage, solange das Ende noch mindestens 10 min entfernt ist; außerdem sofort nach jeder Lücke ab 5 min für alle laufenden Fahrten | Echtzeit sichern, bevor sie verfällt (Abschnitt 6), und Absicherung gegen Schlafmodus. Fehlgeschlagene Abfragen werden nach 2 min wiederholt |
| `live` | alle 5 min, solange die Fahrt gestört ist, höchstens 12 je Fahrt; frühestens 5 min nach irgendeiner anderen Abfrage derselben Fahrt | zeigt, wann eine Maßnahme sichtbar wurde |
| `first` | für Fahrten, die nur auf Tafeln auftauchen und deren Ende unbekannt ist, erst nach abgeschlossenem Planlauf; höchstens 2 Versuche im Abstand von 2 min | Ende bestimmen |
| `late` | einmal, wenn die Endabfrage verpasst wurde, bis 6 h nach Fahrtende; scheitert sie mit einem Netzfehler ohne Antwort, wird sie wiederholt, sobald das Netz zurück ist | Halte und Ausfälle nachtragen; Echtzeit fehlt dann meist |

Jede erfolgreiche Abfrage, gleich aus welchem Anlass, gilt als Endabfrage, wenn die Ankunft am letzten bedienten Halt höchstens 150 s in der Zukunft oder schon in der Vergangenheit liegt. Zeigt etwa eine `live`-Abfrage, dass eine Fahrt vorzeitig endet und den neuen letzten Halt schon erreicht hat, ist die Fahrt damit abgeschlossen und wird nicht mehr nachgeholt.

Gestört ist eine Fahrt, sobald ein entfallener Halt, eine Verspätung ab 180 s oder ein fahrtbezogener Echtzeit-Hinweis (Code beginnt mit `text.realtime.journey.`, etwa Ausfall, Teilausfall, Zusatzfahrt) gesehen wurde. Dauerhinweise (`hint`, darunter „Verkehrt ab … als S41“ auf jeder Ring- und Durchlauffahrt) und Warnungen (Aufzüge, Bauarbeiten, längere Umstiege) zählen nicht; sie gelten tagelang für alle Fahrten eines Bahnhofs. Im Testlauf sinkt der Anteil gestörter Fahrten dadurch von 122 auf 67 von 622, keine Ringfahrt ist mehr darunter. `trip` ist `null`, wenn HAFAS die Fahrt nicht kennt (Status 404).

Die erwartete Ankunft (ETA) kommt aus der jeweils neuesten Quelle: letzter Eintrag in `radar.next`, letzter bedienter Halt der letzten Fahrtabfrage, Soll-Ankunft plus zuletzt gesehene Verspätung, sonst Soll-Ankunft. Das Radar zählt nur, wenn die Soll-Ankunft seines letzten Eintrags zum bekannten Fahrtende passt: Es kennt keine Ausfälle und zeigt bei einer vorzeitig endenden Fahrt weiter das ursprüngliche Ziel.

**plan**

```json
{"v":1,"stream":"plan","ms":1792446072811,"latMs":125,"status":200,"line":"S15","fromWhen":"2026-10-20T02:00:00.000Z",
 "untilWhen":"2026-10-20T06:00:00.000Z","trips":[{"tripId":"1|5344|0|86|20102026","lineId":"de-vbb-11000000-s-bahn-s15-s15-z",
   "fahrtNr":"15137","direction":null,"origin":"900003201","destination":"900007102",
   "plannedDeparture":"2026-10-20T07:17:00+02:00","plannedArrival":"2026-10-20T07:22:00+02:00","cancelled":false}]}
```

Läuft um 02:30 und 14:00 Berliner Zeit und nach jedem Start, wenn der aktuelle Lauf fehlt. Je Linie werden die nächsten 24 h in Fenster von höchstens 4 h zerlegt, das sind 7 Fenster und 175 Anfragen je Lauf, mit höchstens 5 Anfragen pro Minute (rund 35 min). Fenster enden nie auf Mitternacht (Berliner Zeit), sondern um 23:59; HAFAS liefert sonst Fahrten anderer Tage und lässt echte Fahrten weg. Enthalten sind alle Fahrten, die im Fenster unterwegs sind (Ankunft nach Fensterbeginn, Abfahrt vor Fensterende), mit exakt passendem Liniennamen und VBB-Linien-ID. Ein Fenster kann `status: 404` und `trips: []` haben, wenn die Linie dort nicht fährt. Scheitert eine Anfrage, kommt das Fenster ans Ende der Warteschlange; Netzfehler und HTTP 429 zählen dabei nicht als Versuch. Nach drei anderen Fehlschlägen (5xx, Timeout) wird das Fenster aufgegeben und als `error` mit `where: "plan"` protokolliert. Der Plan ist das Rückgrat: Jede geplante Fahrt bekommt eine Endabfrage, auch vollständig entfallene Fahrten und Fahrten, die nie im Radar erscheinen.

Der Plan enthält „Zwillinge“: zwei tripIds derselben Linie mit gleichem Start und gleicher Abfahrtszeit, von denen nur eine wirklich fährt (im Testlauf 36 von 7632 Planfahrten). HAFAS beantwortet die Abfrage des Zwillings oft mit HTTP 400. Der Recorder protokolliert das als `lost`, der Export markiert solche Fahrten als `ghost` (Abschnitt 8).

**dict**

```json
{"v":1,"stream":"dict","ms":1792445234403,"latMs":null,"status":null,"kind":"stop","id":"900053301",
 "data":{"name":"S Wannsee Bhf (Berlin)","lat":52.421728,"lon":13.178932,"products":["suburban","bus","express","regional"]}}
{"v":1,"stream":"dict","kind":"remark","id":"b396cadcf9c0","data":{"type":"warning","code":null,"summary":"Information.",
 "text":"An alle mobilitätseingeschränkte Fahrgäste: …","validFrom":"2026-10-17T09:30:00+02:00","validUntil":"2026-10-20T23:30:00+02:00"}}
```

Jeder Halt und jeder Hinweis wird einmal je Prozess und Betriebstag geschrieben; jeder Betriebstag ist damit in sich vollständig. Hinweistypen: `hint` (Dauerhinweise wie Fahrradmitnahme, aber auch `text.journeystop.product.or.direction.changes.journey.message` „Verkehrt ab S Grünau als S46 in Richtung S Westend“, ein Hinweis auf den Fahrzeugumlauf), `status` (fahrtbezogen, z. B. `text.realtime.journey.cancelled`, `text.realtime.journey.partially.cancelled.between`, `text.realtime.journey.additional.service`, `text.realtime.stop.cancelled`, `text.realtime.stop.additional`, `text.realtime.stop.entry.disabled`, `text.realtime.stop.exit.disabled`, `text.realtime.stop.dep.platformChange`) und `warning` (Störungs- und Bauhinweise mit Gültigkeit).

**context**

| kind | Felder |
|---|---|
| `weather` | `points[]`: `name`, `lat`, `lon`, `current` (Open-Meteo: `temperature_2m` °C, `precipitation`/`rain` mm, `snowfall` cm, `snow_depth` m, `wind_speed_10m`/`wind_gusts_10m` km/h, `weather_code` WMO, `visibility` m, `relative_humidity_2m` %, `time` UTC ohne `Z`), `minutely15` (nächste 8 Viertelstunden: `time`, `precipitation`, `snowfall`, `wind_gusts_10m`). Punkte: Mitte 52,52/13,405, Spandau 52,535/13,20, Lichterfelde 52,43/13,32, Erkner 52,43/13,75, Oranienburg 52,75/13,24 |
| `alerts` | `alerts[]` wie von Bright Sky geliefert (DWD-Warnungen mit `event_de`, `severity`, `onset`, `expires`, …), oft leer |
| `calendar` | `year`, `public[]`, `school[]` wie von OpenHolidays geliefert |

**static**

```json
{"v":1,"stream":"static","ms":1792445234251,"files":{"network":{"sha256":"8deaeb49…","bytes":128753,"copy":"static/network-8deaeb499b6a.json"},
 "tracks3d":{"sha256":"edb37e43…","bytes":141706},"zones":{"sha256":"b2455f0d…","bytes":97764}}}
```

Mit `--gtfs` zusätzlich `gtfs: {etag, bytes, path}`. Ist `network.json` beim Start gerade ungültig (weil es neu gebaut wird), nutzt der Recorder die neueste Kopie in `v1/static/`.

**log**

| type | Felder |
|---|---|
| `start` | `config`, `node`, `pid`, `targets`, `keyTargets` |
| `stop` | `signal` (`SIGINT`, `SIGTERM`, `SIGHUP`, `minutes`, `lock`) |
| `gap` | `fromMs`, `toMs`, `reason` (siehe Abschnitt 7) |
| `lost` | `tripId`, `reason`, `fetch`: Fahrt ohne verwertbare Endabfrage aufgegeben. `reason` ist `HTTP 400`/`HTTP 404` (HAFAS lehnt die Fahrt ab oder kennt sie nicht), `end <status>` (Endabfrage und beide Wiederholungen gescheitert, Ende schon vorbei), `late <status>`/`first <status>` (Nachhol- bzw. zweite Erstabfrage mit HTTP-Fehler oder Timeout gescheitert; Netzfehler ohne Antwort führen nie zu `lost`), `late expired`, `expired`; `fetch` ist der Anlass der letzten Abfrage |
| `error` | `where` (`compress`, `context`, `gtfs`, `plan` für ein aufgegebenes Planfenster, `lock`, `uncaught`, `unhandled`), `msg` |
| `health` | einmal pro Minute: `spanS` (Sekunden seit dem letzten Eintrag, nach Schlafmodus mehr als 60), `streams.{radar,running,board,trip,plan,context}` mit `n` (abgeschlossene Anfragen), `ok`, `s4xx` (auch 404), `s429`, `s5xx`, `timeout`, `err` (Netz- oder Parse-Fehler), `p50`, `p95` (Latenz in ms) und bei Fehlern `lastErr`; dazu `budgetNow`, `tokens`, `queue` (fällige, noch nicht gestartete Abfragen), `radarTrains`, `runningTrains`, `tracked` (offene Fahrten), `pendingEnd` |

### 4.4 Messwerte aus den Testläufen

Testlauf am Montag, 19.10.2026, 23:27 bis 00:33 Uhr (späte Abendlage, rund 125 Züge im Radar und 150 laufende Fahrten), überwiegend mit `--budget 35`, mit fünf Neustarts.

| Stream | Klartext je Stunde | gzip je Stunde | Bemerkung |
|---|---|---|---|
| `radar` | 31 MB | 1,3 MB | 120 Schnappschüsse, rund 11 KB gzip je Schnappschuss |
| `running` | 3,3 MB | 0,29 MB | 60 Abfragen |
| `trip` | 9,6 MB | 0,46 MB | Ringfahrten mit mehreren Umläufen haben über 100 Halte |
| `board` | 1,4 MB | 0,08 MB | nur geänderte Zeilen |
| `dict`, `context`, `log`, `static` | 0,7 MB | 0,1 MB | |
| `plan` | – | 0,2 MB je Lauf | zweimal täglich |

Hochgerechnet auf einen Tag mit Tagesverkehr (rund 200 Züge im Radar, 300 laufende Fahrten, volles Budget) ergibt das etwa 3–4 MB gzip je Stunde, also **rund 70 MB pro Tag und gut 2 GB pro Monat**. Die offene Stunde liegt unkomprimiert vor; die Radar-Datei wird dabei nachts gut 30 MB und zur Hauptverkehrszeit knapp 50 MB groß. `state.json` war im Testlauf nachts 2,4 MB groß (7563 Fahrten, davon 2,1 MB Fahrtzustand); nach dem 14-Uhr-Planlauf, der 24 h vorausschaut, wächst es auf etwa 4 MB.

Gemessene Anfragerate: im Mittel 35,3 Anfragen pro Minute bei Budget 35 (höchstens 37 in einer Minute, wegen des Puffers von 3 Token), ohne einen einzigen 429-, 5xx- oder Timeout-Fehler. Latenz im Median: Radar 1,7 s, Tafeln 0,12 s, Fahrten 0,15 s, laufende Fahrten 0,3 s.

Ein zweiter Lauf in der Nacht zum 20.10.2026 (01:43 bis 02:03 Uhr, Budget 30, drei Sitzungen mit zwei Neustarts, Ende per `--minutes` und per SIGHUP, ein Stundenwechsel) kam im Mittel auf 30,5 Anfragen pro Minute (höchstens 32 in der ersten Minute nach einem Start) ohne 429-, 5xx- oder Timeout-Fehler bei BVG. Beide Neustarts wurden als `restart`-Lücke erkannt, die Stunde wurde beim Start komprimiert und ins Manifest eingetragen, und ein zweiter Recorder auf demselben Verzeichnis brach wie vorgesehen ab.

## 5. Zeit

- Rohdaten sortiert man immer nach `ms`. Dateinamen sind UTC.
- API-Zeiten behalten ihren Offset (`+02:00` Sommerzeit, `+01:00` Winterzeit).
- Betriebstag: für Fahrten das Datum am Ende der tripId, `1|55350|0|86|19102026` gehört zum 19.10.2026. Der Tag steht dort ohne führende Null (`9112026` ist der 9.11.2026). Für alles andere gilt das Berliner Datum von `ms − 3 h`.
- Ein Betriebstag reicht damit von 03:00 bis 03:00 Berliner Zeit (genauer: von Mitternacht + 3 h bis Mitternacht + 3 h). Am 25.10.2026 endet die Sommerzeit: Der Betriebstag 2026-10-25 beginnt um 01:00 UTC und endet am 26.10. um 02:00 UTC, hat also 25 Stunden. Im März hat der entsprechende Tag 23 Stunden. Der Export setzt dafür `meta.hours` und `meta.dstChange`.
- Fahrten der Nachtverkehre am Wochenende laufen mit der tripId des Vortags über 03:00 hinaus. Der Export ordnet jede Fahrt vollständig dem Tag ihrer tripId zu; ihre Halte, Schnappschüsse und Kennzahlen können daher hinter `meta.endS` liegen.
- Nachtregeln (Tafeln seltener zwischen 01 und 04 Uhr) und die Plan-Zeiten 02:30/14:00 gelten in Berliner Ortszeit. Welcher Planlauf gerade dran ist, ergibt sich aus der Berliner Zeit von `jetzt − 2,5 h` (vor bzw. nach 11:30), damit läuft der Plan auch in der Nacht der Zeitumstellung genau einmal.

## 6. Datenqualität

- **Positionen sind geschätzt.** `radar` und `running` liefern von HAFAS interpolierte Positionen aus Fahrplan und Prognose, kein GPS. Ein Zug, der real steht, kann im Radar weiterfahren und umgekehrt.
- **Nur minutengenau.** Alle Zeiten und Verspätungen sind auf ganze Minuten gerundet (Verspätung 0, 60, 120 … s). Schwellen in Abschnitt 9 berücksichtigen ±60 s.
- **`null` ist nicht 0.** `delay: null` heißt keine Prognose, nicht pünktlich.
- **Ausreißer um Mitternacht.** Das Radar liefert für Halte mit Sollzeit 00:00–00:02 gelegentlich Prognosen drei Tage in der Zukunft (Verspätung um 276 000 s). Die Rohdaten bleiben unverändert; Recorder und Export ignorieren Verspätungen außerhalb von −30 min bis +6 h.
- **Echtzeit verfällt etwa 80 min nach jedem Halt, nicht erst nach Fahrtende.** In Endabfragen langer S-Bahn-Fahrten haben 82–86 % der Halte, die 0–60 min zurückliegen, eine Verspätung, bei 60–80 min noch 73 %, bei 80–100 min 3 % und danach keine mehr. Deshalb fragt der Recorder Fahrten ab 60 min Länge mindestens alle 50 min ab (`mid`) und die letzten Halte kurz vor dem Ende (`end`). Nachholabfragen (`late`) nach einer Lücke haben meist gar keine Echtzeit mehr. Abfragen ohne Echtzeit überschreiben im Export keine früher gesehenen Ausfälle oder Gleiswechsel.
- **Der Ring hat bei HAFAS kaum Echtzeit.** Für S41 und S42 liefert BVG-HAFAS fast nie Verspätungen: Im Testlauf hatte keine der 11 Ring-Endabfragen eine Verspätung, bei längeren Läufen nur 3–21 von 67–93 vergangenen Halten, und von rund 600 Tafelzeilen für S41/S42 keine einzige eine Verspätung ungleich 0. Das liegt an der Quelle, nicht an der Aufzeichnung; `meta.rtShare` ist für S41/S42 deshalb nahe 0. Ring-Positionen kommen außerdem überwiegend aus `running` (jede Minute, ohne Verspätung), weil der Ring im Radar nur teilweise und unregelmäßig erscheint. Abhilfe wäre eine zweite Quelle (Abschnitt 12).
- **U-Bahn-Echtzeit.** U-Bahn-Fahrten haben Echtzeit, solange sie rechtzeitig abgefragt werden; der Export gibt je Linie `meta.rtShare` und `meta.rtN` an.
- **Ausfälle können zurückgenommen werden.** Ein Halt, der zunächst als entfallen gemeldet wird, kann später wieder mit Verspätung bedient werden (im Testlauf 4 von 31 auf Tafeln gemeldeten Ausfällen). Der Export setzt einen Ausfall nur aus Fahrtabfragen und Tafeln und hebt ihn nur auf, wenn eine spätere Fahrtabfrage oder Tafel den Halt mit Verspätungsangabe als bedient zeigt (Abschnitt 8). `cancelSeenS` bleibt als Zeitpunkt der ersten Meldung erhalten.
- **Das Radar kennt keine Ausfälle.** In den Halten von `radar.next` ist `cancelled` nie `true` (0 von 50 712 Einträgen im Testlauf). Nach einem Teilausfall rechnet HAFAS den Zug weiter über den entfallenen Abschnitt bis zum ursprünglichen Ziel, mit Verspätung 0. Radar und `running` gehen deshalb nicht in Ausfälle ein, und für das erwartete Fahrtende zählt das Radar nur, solange sein Ziel zum bekannten Fahrtende passt (Abschnitt 4.3).
- **Zwillinge und überlappende Fahrten.** HAFAS modelliert Ringumläufe als etwa zweistündige Fahrten, die sich um eine Runde überlappen, sodass derselbe Zug zur selben Minute in zwei tripIds auftaucht; außerdem gibt es Ersatz-tripIds bei Echtzeitänderungen (z. B. S46 `1|1604|3` und `1|84800|0` mit derselben Zugnummer) und Zwillinge im Plan. Der Export markiert solche doppelten Halte (`stopEvents.dupOf`) und verknüpft die Fahrten über `trips.trainId` (Abschnitt 8).
- **Prognose-Artefakte.** Ist-Zeiten vergangener Halte sind teils fortgeschriebene Prognosen. Fahrzeiten, die mehr als 60 s unter der Soll-Fahrzeit liegen (im Testlauf 56 von 6235, z. B. Soll 120 s, Ist 0 s), sind physikalisch unplausibel; der Export setzt `runs.actualS` dann auf `null`.
- **Auslastung** (`occupancy`) kommt praktisch nur bei der U-Bahn vor (`low`, `medium`, `high`).
- **Tafeln sind Änderungsprotokolle.** Nur geänderte Zeilen werden geschrieben (Abschnitt 4.3).
- **Hinweise sind teils bahnhofsbezogen.** Warnungen wie „Aufzug außer Betrieb“ hängen an allen Abfahrten eines Bahnhofs; der Export ordnet sie der Kategorie `accessibility` zu und zählt sie nicht als Störung.
- **Sonderfahrten mit Linie `1`.** HAFAS führt manche Ersatz- oder Zusatzzüge der S-Bahn mit Linienname `1` und ohne Betreiber. Im Export steht dann `lineKnown: false`.

## 7. Lücken und Coverage-Masken

Der Recorder schreibt `log`-Einträge vom Typ `gap`:

| reason | Erkennung |
|---|---|
| `sleep` | zwischen zwei Takten (1 s) sind mehr als 30 s Wanduhr vergangen, und die monotone Uhr (`performance.now()`) ist ebenso weit gelaufen (Schlafmodus, angehaltener Prozess). Unter macOS läuft die monotone Uhr von Node im Schlafmodus weiter (`mach_continuous_time`); unter Linux nicht, dort erscheint ein Suspend als `clock` |
| `clock` | die Wanduhr ist um mehr als 30 s vorgesprungen, ohne dass die monotone Uhr mitgelaufen ist (Zeitkorrektur), oder um mehr als 30 s zurückgesprungen; beim Rücksprung ist `fromMs > toMs`, und der Zeitraum dazwischen kann in den Rohdaten doppelt vorkommen. Nach einem Rücksprung werden alle Zeitstempel des Schedulers auf „jetzt“ zurückgesetzt, die der Tafeln zufällig über die letzten 15 min verteilt, damit die Tafeln sofort gleichmäßig weiterlaufen |
| `offline` | alle Anfragen scheitern mindestens 60 s lang mit Netzfehlern; von der ersten Störung bis zur nächsten Antwort. Timeouts zählen nicht dazu (der Server ist dann erreichbar, aber langsam) |
| `noradar` | mehr als 90 s kein Radar, unabhängig von anderen Lücken; von der letzten erfolgreichen Radar-Antwort bis zur nächsten (Rate-Limit, Serverfehler, Timeouts, aber auch Schlafmodus) |
| `restart` | beim Start lag der letzte gespeicherte Lebenszeitpunkt mehr als 60 s zurück |

Nach jeder Lücke von mindestens 5 Minuten werden alle laufenden Fahrten sofort abgefragt (`mid`, höchstens 8 pro Minute). Fahrten, deren erwartetes Ende mehr als 3 Minuten zurückliegt, ohne dass eine Endabfrage gelang, kommen in die Nachholliste (`late`); das gilt nach jeder Lücke. Solange Anfragen mit Netzfehlern ohne Antwort scheitern, werden keine Fahrt- und Planabfragen gestartet; sie laufen mit der ersten Antwort von Radar oder Tafel wieder an, ohne dass vorher Versuche verbraucht wurden.

Der Export fasst das in `meta.gaps` zusammen und ergänzt Abschnitte ohne Radar von mindestens 3 Minuten als `nodata`. `meta.coverage` enthält je Stream eine Zeichenkette mit einem Zeichen pro Minute des Betriebstags (1440, am Umstellungstag 1500 oder 1380): bei `radar` und `running` `1` für vorhanden und `0` für fehlend, bei `board` und `trip` die Anzahl der Abfragen in dieser Minute (gedeckelt auf 9).

Eine Minute gilt als **abgedeckt**, wenn in ihr ein Radar- oder `running`-Schnappschuss vorliegt. `snapshots`, `lineState` und `kpis` enthalten nur abgedeckte Minuten (auch jenseits von `meta.endS` für Fahrten über 03:00 hinaus), `kpis.coverage` gibt den abgedeckten Anteil eines 5-min-Fensters an. Aktionen, deren Entscheidung höchstens 60 s nach Beginn eines abgedeckten Abschnitts oder nach der ersten Echtzeit-Beobachtung der Fahrt sichtbar wurde, tragen `censored: true` (Abschnitt 9).

## 8. Exportformat

```bash
node scripts/export.mjs --from 2026-10-20 --to 2026-10-26 [--dir recordings] [--out exports] [--gzip] [--positions] [--events events.json] [--network public/data/network.json]
```

Optionen gehen auch in der Form `--from=2026-10-20`. Schreibt je Betriebstag `exports/<Tag>.json` (mit `--gzip` `.json.gz`). Gelesen werden die UTC-Stunden des Tages plus eine Stunde davor und drei danach. `--events` nimmt eine JSON-Liste von Veranstaltungen (`name`, `startS`/`endS` oder `start`/`end` als ISO, optional `lat`, `lon`, `station`, `visitors`) und übernimmt die, die den Tag berühren. Liegt neben `network.json` eine `tracks3d.json`, werden Positionen in `snapshots` entlang dieser Gleisgeometrie interpoliert, sonst entlang der Abschnitte aus `network.json` (`meta.geometry`).

Konventionen: Zeiten sind Sekunden seit 1970 UTC (Felder auf `S`), Verspätungen und Dauern Sekunden, `null` unbekannt. Große Tabellen haben die Form `{columns: [...], rows: [[...], ...]}`. Ein Bahnhof (`station`) ist die ID aus `network.json`, deren `ids[]` die HAFAS-Halt-ID enthält; `stop` ist die HAFAS-ID selbst. `line` ist der Linienname; Linien außerhalb von `network.json` haben bei `trips` `lineKnown: false`. `dirTo` ist der Endbahnhof der Netzlinie, auf den die Fahrt zuläuft, bestimmt aus der Reihenfolge der Halte in `network.json`. Beim Ring hat jede Linie nur eine Richtung (S41 im Uhrzeigersinn, S42 gegen den Uhrzeigersinn), `dirTo` ist dort immer der letzte Bahnhof der Netzliste. Bei unbekannten Linien ist `dirTo` das Fahrtziel.

**Doppelte Halte.** Zwei Halte gelten als derselbe physische Halt, wenn Linie, `dirTo`, Bahnhof und Soll-Ankunft oder Soll-Abfahrt übereinstimmen. Einer davon ist der primäre Halt (Vorrang: Echtzeit-Beobachtung, bedient, abgefragt, frühere Fahrt), die anderen tragen in `stopEvents.dupOf` die tripId des primären Halts. Alle abgeleiteten Tabellen (`runs`, `headways`, `turnbacks`, `snapshots`, `lineState`, `kpis`, `actions`) zählen nur primäre Halte. `forecasts` behalten auch Prognosen für doppelte Halte und nehmen das Label `finalDelayS` notfalls vom primären Halt.

**meta**

| Feld | Bedeutung |
|---|---|
| `schema` | `sbahn-ubahn-ops/2` |
| `serviceDay`, `tz` | Betriebstag, `Europe/Berlin` |
| `startS`, `endS`, `hours` | Beginn, Ende (exklusiv), Länge in h (24, 25 oder 23) |
| `dstChange` | Zeitumstellung in diesem Betriebstag |
| `networkSha` | sha256 der verwendeten Netzversion |
| `geometry` | `tracks3d` oder `network`: Quelle der Gleisgeometrie für Positionen |
| `counts` | Zeilenzahl jeder Tabelle |
| `gaps[]` | `{fromS, toS, reason}` |
| `coverage` | `{stepS: 60, radar, running, board, trip}` (Abschnitt 7) |
| `rtShare`, `rtN` | je Linie Anteil der bedienten, nicht doppelten Halte mit gemessener Ist-Zeit (0–1) und deren Anzahl. Gezählt werden nur Halte in abgedeckten Minuten von Fahrten, die mindestens 10 min vor dem Ende der Aufzeichnung planmäßig endeten; `null`, wenn es keine gibt |

**network**: `lines` und `stations` aus `network.json`; `segments[]` mit `from`, `to`, `lines`, `lengthM` (m, aus der Geometrie); `corridors[]` (`id`, `lines`, `stations`): maximale Ketten von Abschnitten mit identischer Menge von mindestens zwei Linien, z. B. die Stadtbahn; `singleTrack[]`: eingleisige Abschnitte (`line`, `from`, `to`, `name`, `verified: false`, von Hand eingetragen und nicht geprüft); `termini`: je Linie die beiden Endbahnhöfe; dazu die beobachteten Betriebsgrenzen:

`turnStations[]` (je Bahnhof und Produkt, ohne Ring): `station`, `product`, `lines`, `starts`/`ends` (Linien, deren Fahrten dort laut Plan beginnen bzw. enden, aus allen gelesenen Planläufen, also auch den Fahrten des Folgetags), `cuts` (Anzahl der Fahrten, die dort an diesem Tag wegen Teilausfall vorzeitig endeten oder später begannen), `terminus` (Endpunkt einer Netzlinie), `turns`, `turnMinS`, `turnMedianS` (beobachtete Wendezeiten aus `turnbacks`). Ein Bahnhof mit `starts`/`ends` ist ein planmäßiger Wende- oder Abstellpunkt; einer nur mit `cuts` ist ein beobachteter Notwendepunkt. Andere Bahnhöfe sind als Wendepunkt nicht belegt. Über mehrere Tage vereinigt ergibt sich eine immer vollständigere Liste.

`minHeadways[]` (je gerichtetem Abschnitt zwischen benachbarten Bahnhöfen): `from`, `to`, `lines`, `n` (Abfahrten), `plannedMinS` (kleinster Soll-Abstand zweier Abfahrten am Startbahnhof, alle Linien zusammen), `observedMinS` (kleinster gemessener Abstand), `nObserved`. Das ist eine beobachtete Untergrenze in Minutenauflösung; parallele Gleise (verschiedene Linien auf getrennten Gleisen) können sie unterschreiten. Empfehlungen, die Abstände darunter erzeugen würden, gelten als nicht machbar.

**context**: `calendar` (`weekday`, `publicHoliday` Name oder `null`, `schoolHoliday` Name oder `null`, `dstChange`), `weather` als Tabelle (`tS`, `point`, dann die Open-Meteo-Felder aus Abschnitt 4.3), `forecast15` als Tabelle (`tS` Abrufzeit, `point`, `validS` Gültigkeitszeitpunkt, `precipitation`, `snowfall`, `wind_gusts_10m`; je Abruf die nächsten 8 Viertelstunden), `alerts[]` (DWD-Warnungen des Tages, einmal je ID), `events[]`.

**trips** (Liste von Objekten, eine je Fahrt des Betriebstags):

| Feld | Einheit | Bedeutung |
|---|---|---|
| `tripId`, `serviceDay` | – | HAFAS-Fahrt, Betriebstag |
| `trainId` | – | tripId der frühesten Fahrt desselben physischen Zuges: Fahrten mit doppelten Halten (überlappende Ringumläufe, Ersatz-tripIds, Zwillinge) und Ringfahrten, die nahtlos aneinander anschließen (Ankunft der einen = Abfahrt der nächsten am selben Bahnhof, höchstens 2 min später). Wenden an Endpunkten stehen in `turnbacks` |
| `line`, `lineKnown`, `lineVariant`, `product`, `operator`, `fahrtNr` | – | Linie, Netzlinie bekannt, HAFAS-Variante, Produkt, Betreiber, Zugnummer |
| `direction`, `dirTo` | – | Zieltext laut HAFAS, Richtung im Netz |
| `originStation`, `destStation` | – | erster und letzter Halt laut Plan |
| `plannedStartS`, `startS`, `plannedEndS`, `endS` | s | Soll/Ist Abfahrt am ersten bedienten Halt, Soll/Ist Ankunft am letzten |
| `status` | – | `ok`, `partial` (Halte entfallen), `cancelled` (alle Halte entfallen), `unfetched` (keine Fahrtabfrage, nur Plan/Tafel/Radar), `ghost` (Plan-Eintrag ohne eigene Fahrt: HAFAS lehnt die Abfrage ab, oder die Fahrt wurde in Echtzeit nie gesehen und ihre Halte doppeln in abgedeckter Zeit einen beobachteten Zug) |
| `rt` | bool | mindestens ein Halt mit gemessener Ist-Zeit |
| `nStops`, `nCancelled`, `nDup` | Anzahl | Halte, davon ganz entfallen, davon doppelt |
| `maxDelayS`, `endDelayS` | s | größte Verspätung, Verspätung am Ziel |
| `firstSeenS` | s | erste Beobachtung in irgendeinem Stream |
| `observed` | bool | in Echtzeit gesehen (Fahrtabfrage, Tafel, Radar oder `running`) |
| `sources` | – | Streams, in denen die Fahrt vorkam (`plan`, `radar`, `running`, `board`, `trip`) |
| `lost` | – | `reason` des letzten `lost`-Eintrags im Log, sonst `null` |

`ghost`-Fahrten erscheinen nur in `trips` und `stopEvents` und fließen in keine abgeleitete Tabelle ein.

**stopEvents** (eine Zeile je Halt und Fahrt): `tripId`, `seq` (Reihenfolge), `station`, `stop`, `plannedArrS`, `arrS`, `arrDelayS`, `plannedDepS`, `depS`, `depDelayS`, `dwellPlanS` (Soll-Haltezeit), `dwellS` (Ist-Haltezeit), `plannedPlatform`, `platform`, `cancelled` (Halt wird gar nicht bedient), `arrCancelled` (Ankunft entfällt), `depCancelled` (Abfahrt entfällt, z. B. am letzten bedienten Halt einer vorzeitig endenden Fahrt), `rt`, `occupancy`, `src`, `cancelSeenS`, `dupOf` (tripId des primären Halts oder `null`).
Sollzeiten stammen aus der letzten Fahrtabfrage, sonst aus Plan, Tafel oder Radar. Ist-Zeiten stammen aus der letzten Fahrtabfrage, in der der Halt Echtzeit hatte und zum Abfragezeitpunkt höchstens 2 min in der Zukunft lag (`src: "trip"`, `rt: true`). Sonst wird die letzte Prognose aus Tafel oder Radar genommen (`src: "board"`/`"radar"`, `rt: false`). Gibt es keins von beiden, sind `arrS`/`depS` `null`. Ausfälle stammen nur aus Fahrtabfragen und Tafeln, getrennt für Ankunft und Abfahrt: Ein Ausfall gilt ab der ersten Beobachtung, die ihn zeigt, und wird nur durch eine **spätere** Fahrtabfrage oder Tafel aufgehoben, die die Ankunft bzw. Abfahrt mit Verspätungsangabe als bedient zeigt. Radar und `running` ändern Ausfälle nie, weil das Radar entfallene Halte mit Verspätung 0 weiterführt (Abschnitt 6); Abfragen ohne Echtzeit (typisch `late`) ändern daran ebenfalls nichts. Das Ist-Gleis stammt aus der zeitlich letzten Beobachtung mit Echtzeit (Fahrtabfrage, Tafel oder Radar). `cancelSeenS` ist der erste Zeitpunkt, zu dem ein Ausfall des Halts sichtbar war, auch wenn er später zurückgenommen wurde.

**runs** (Fahrt zwischen zwei bedienten, nicht doppelten Halten): `tripId`, `line`, `dirTo`, `from`, `to`, `plannedS` (Soll-Fahrzeit), `actualS` (Ist-Fahrzeit, nur aus gemessenen Zeiten; `null`, wenn mehr als 60 s unter Soll, Abschnitt 6), `gainS` (`plannedS − actualS`, positiv = Zeit aufgeholt), `corridor`.

**headways** (je Bahnhof, Linie und Richtung, sortiert nach Abfahrt): `station`, `line`, `dirTo`, `tripId`, `plannedDepS`, `depS`, `hPlanS` (Soll-Abstand zur vorherigen geplanten Abfahrt, auch wenn diese entfiel), `hS` (Abstand zur vorherigen nicht entfallenen Abfahrt, aus `stopEvents.depS`, also gemessen oder, ohne Messung, die letzte Prognose), `ratio` (`hS/hPlanS`), `bunch` (`ratio < 0,5`), `gap` (`ratio > 1,5`), `rt` (`true`, wenn beide Abfahrten gemessen sind, `stopEvents.rt`). `bunch` und `gap` sind nur bei `rt: true` gesetzt; im Testlauf waren 5256 von 6749 Abständen gemessen. Entfällt ein Zug, wird der nächste Abstand groß, das ist gewollt.

**turnbacks** (Wende an einem Endpunkt): Ankunft einer Linie am letzten bedienten Halt, gepaart mit der nächsten Abfahrt derselben Linie in Gegenrichtung von dort, 4–20 min später, bevorzugt am selben Gleis. Die Paarung ist heuristisch und kein amtlicher Umlauf. Ringlinien (S41, S42) wenden nicht und fehlen hier. Spalten `station`, `line`, `inTripId`, `outTripId`, `arrS`, `depS`, `plannedTurnS` (Soll-Wendezeit), `turnS` (Ist-Wendezeit), `arrDelayS`, `depDelayS`, `carryS` (`depDelayS − arrDelayS`: negativ = Verspätung in der Wende abgebaut, positiv = in der Wende zusätzlich entstanden), `platform`.

**forecasts** (Prognose-Labels): jede Prognose aus Tafeln, Radar und Fahrtabfragen für einen späteren Halt, nur wenn sich der vorhergesagte Wert für denselben Halt und dieselbe Quelle geändert hat. Spalten `obsS` (Zeitpunkt der Beobachtung), `src` (`board`, `radar`, `trip`), `tripId`, `station`, `kind` (`arr`/`dep`), `plannedS`, `predDelayS`, `horizonS` (Zeit bis zum vorhergesagten Ereignis; negativ = Ereignis lag schon zurück), `finalDelayS` (gemessene Verspätung, nur bei `rt`, notfalls vom primären Halt), `errS` (`predDelayS − finalDelayS`).

**disruptions** (ein Eintrag je Hinweis): `hash`, `type`, `code`, `category`, `disruption`, `summary`, `text`, `validFromS`, `validUntilS`, `firstSeenS`, `lastSeenS`, `lines`, `stations`, `nTrips`. Kategorien per Stichwort in `summary` und `text`: `accessibility` (Aufzug, Fahrtreppe, Rollstuhlrampe, Barrierefreiheit), `passenger_info` (Fahrgastinformation, etwa wegen Vandalismus), `persons_on_track`, `police`, `medical`, `fire`, `interlocking`, `signal`, `points`, `vehicle_defect`, `construction`, `weather`, `strike`, `previous_delay`, sonst `other`; Dauerhinweise `hint`. `disruption` ist `false` bei `hint`, `accessibility` und `passenger_info`, sonst `true`. Der Recorder ist für seine `live`-Abfragen strenger und wertet nur fahrtbezogene Echtzeit-Hinweise, Ausfälle und Verspätungen (Abschnitt 4.3).

**sev**: `{line, fromS, toS, maxVehicles, startObserved, endObserved}`, Abschnitte mit SEV-Bussen einer Linie in mindestens 3 Radar-Schnappschüssen (Unterbrechungen bis 5 min werden überbrückt). `startObserved`/`endObserved` sind `true`, wenn der Radar-Schnappschuss direkt davor bzw. danach (höchstens 90 s Abstand) ohne diese Busse vorliegt, der Beginn bzw. das Ende also wirklich beobachtet wurde.

**actions**, **incidents**: siehe Abschnitt 9.

**snapshots** (Zustand je abgedeckter Minute und Zug): `t`, `tripId`, `line`, `dirTo`, `lat`, `lon`, `fromStation`, `toStation`, `frac` (0–1 Anteil zwischen den Bahnhöfen), `atStation` (Bahnhof, wenn der Zug hält), `delayS`, `knownDelayS`, `leaderGapS` (Abstand zum vorausfahrenden Zug derselben Linie und Richtung am nächsten Bahnhof, `headways.hS`, also auch prognostiziert, wenn `headways.rt` falsch ist), `followerGapS` (zum folgenden Zug), `occupancy`, `stoppedS` (seit wann die Radar-Position sich um weniger als 30 m bewegt hat), `observed` (Zug in der letzten Minute im Radar oder in `running` gesehen). Enthalten sind nur Fahrten, die in Echtzeit beobachtet wurden (`trips.observed`), keine `ghost`-Fahrten und keine Minuten, deren nächster Halt doppelt ist; so steht jeder Zug je Minute genau einmal in der Tabelle. Positionen folgen der Gleisgeometrie (`meta.geometry`).

**lineState** (je abgedeckter Minute, Linie und Richtung, aus `snapshots`): `t`, `line`, `dirTo`, `active` (Züge unterwegs), `observed` (davon in der letzten Minute gesehen), `meanDelayS`, `maxDelayS`, `knownMeanDelayS`, `knownMaxDelayS`, `headwayCv`, `bunching`, `gaps` (Anzahl Züge mit gemessenem Abstand unter 0,5 bzw. über 1,5 × Soll; `headwayCv` ebenfalls nur aus gemessenen Abständen, `headways.rt`), `cancelledNext30` (entfallene Halte in den nächsten 30 min laut endgültigem Stand), `knownCancelledNext30` (davon bis `t` schon gemeldet), `sevActive`.

**kpis** (je 5 min, Linie und Richtung, nach Sollzeit, nur abgedeckte Minuten und primäre Halte): `t`, `line`, `dirTo`, `coverage` (abgedeckter Anteil der 5 Minuten), `arrivals`, `punct1`, `punct4`, `punct6`, `cancelledTrips`, `cancelledStops`, `ewtS`, `headwayCv`, `bunching`, `gaps`, `stalls`, `crowdGap`, `paxDelayS` (Abschnitt 10).

**positions** (nur mit `--positions`): Rohpositionen `tS`, `src` (`radar` alle 30 s, `running` alle 60 s), `tripId`, `line`, `lat`, `lon`.

## 9. Abgeleitete Maßnahmen

Die Rohdaten bleiben unverändert; Maßnahmen werden nur im Export abgeleitet. Ziel ist, echte Entscheidungen der Disposition zu erfassen und planmäßige Fahrplaneffekte (Bauarbeiten, Ein- und Aussetzfahrten, Minutenrundung) auszuschließen, damit ein Modell nicht den Fahrplan nachahmt.

Jede Maßnahme in `actions[]` hat:

| Feld | Bedeutung |
|---|---|
| `id`, `type`, `subtype`, `tripId`, `line`, `dirTo`, `station` | Art und Ort |
| `plannedS` | Sollzeit des betroffenen Ereignisses |
| `decidedS` | erste Beobachtung, die die Änderung zeigt |
| `leadS` | `plannedS − decidedS` (Vorlauf; negativ, wenn die Änderung erst nachträglich sichtbar wurde) |
| `censored` | `true`, wenn die Änderung schon bei Beginn der Beobachtung sichtbar war: `decidedS` liegt höchstens 60 s nach dem Beginn des abgedeckten Abschnitts oder nach der ersten Echtzeit-Beobachtung der Fahrt (oder fehlt). `decidedS` ist dann nur eine obere Schranke für den Entscheidungszeitpunkt, `leadS` eine untere |
| `feasible` | bei Wendemaßnahmen (`partial`, `short_turn`): `true`, wenn am Bahnhof laut Plan Züge desselben Produkts wenden oder dort an diesem Tag mindestens eine andere Fahrt vorzeitig endete (`network.turnStations`), sonst `false` (Wende dort nicht belegt, Ableitung zweifelhaft oder Notwende); bei `cancel`, `renumber`, `skip_stop`, `hold`, `sev_*` `true`; sonst `null` |
| `recurring` | Anzahl gleichartiger Maßnahmen (gleicher Typ, Untertyp, Linie, Bahnhof) am selben Tag. Ab 3 handelt es sich meist um eine planmäßige Regelung (z. B. Gleiswechsel wegen Bauarbeiten), nicht um eine spontane Entscheidung |
| `confidence` | 0–1 |
| `evidence[]` | `src`, `obsS`, `field`, `value` |
| `stateT` | Minute für die Verknüpfung mit `snapshots`/`lineState` |
| `outcome` | `delay30BeforeS`/`delay30AfterS`: mittlere gemessene Ankunftsverspätung der Linie und Richtung 30 min vor/nach `plannedS`; `cvBefore`/`cvAfter`: Variationskoeffizient der Abstände |

| type | Regel | Konfidenz |
|---|---|---|
| `cancel` | alle Halte entfallen (Status `cancelled`) und die Fahrt ist kein Doppel eines anderen Zuges. Hinweise wie „Fällt aus“ an einzelnen Halten oder `trip.cancelled` reichen nicht | 1,0 |
| `partial` | Halte am Anfang (`head`) oder Ende (`tail`) entfallen; `station` ist der erste bzw. letzte noch bediente Halt (dort entfällt nur die Ankunft bzw. Abfahrt) | 0,9 |
| `short_turn` | `partial` am Ende, und ein Zug derselben Linie in Gegenrichtung fährt 3–15 min nach der Ankunft am Schnittpunkt dort ab | 0,8 |
| `renumber` | `partial` am Ende, und eine andere Fahrt derselben Linie (oder einer unbekannten Linie wie `1`) fährt am Schnittpunkt ±1 min zur Sollzeit ab und bedient danach entfallene Halte (Beispiel S1 13100 → 10161); die Nachfolgefahrt zählt nicht als `add` | 0,9 |
| `add` | Hinweis `journey.additional.service` (0,9) oder eine in Echtzeit beobachtete Fahrt fehlt im Plan, obwohl für die Linie ein Planfenster zur Abfahrtszeit vorliegt (0,7) | 0,9 / 0,7 |
| `skip_stop` | ganz entfallener Halt mit bedienten Halten davor und danach | 0,9 |
| `platform_change` | Ist-Gleis aus einer Echtzeit-Beobachtung ≠ Soll-Gleis (verglichen über die Gleisnummer) | 1,0 |
| `hold` | an einem Zwischenhalt aus gemessenen Zeiten: Ankunft pünktlich oder verspätet (`arrDelay ≥ 0`) und Abfahrtsverspätung mindestens 180 s über der Ankunftsverspätung. Früh angekommene Züge, die nur ihre Abfahrtszeit abwarten, und die 120 s der Minutenrundung zählen nicht. Als Ankunftsverspätung gilt mindestens die Abfahrtsverspätung am vorherigen Halt minus 60 s: HAFAS lässt Ankunftszeiten teils unverändert, sodass eine Fahrt sonst Minuten schneller als möglich wäre (dieselbe Grenze wie bei `runs.actualS`) und ein Halten vorgetäuscht würde. Das gilt auch für `terminus`. `regulate`, wenn der Abstand zum Vordermann bei Ankunft unter 0,7 × Soll-Takt lag; `connection` an Knoten (≥ 3 Linien), wenn ein Zubringer einer anderen Linie mit ≥ 120 s Verspätung 0–5 min vor der Abfahrt ankam; `terminus`, wenn in einer Wende die gemessene Abfahrtsverspätung mindestens 180 s über der gemessenen, nicht negativen Ankunftsverspätung liegt; sonst `other` | 0,6 |
| `reroute` | `additional_stop`: Halt mit Echtzeit-Hinweis `stop.additional` (0,8); `diversion`: bedienter Halt an einem Bahnhof außerhalb der Netzlinie mit Halten der Linie davor und danach, wenn dasselbe Muster an diesem Tag bei höchstens 2 Fahrten der Linie vorkommt (0,6). Bahnhöfe, die in der Haltfolge ganz fehlen (Durchfahrt wegen Bauarbeiten), Ein- und Aussetzfahrten am Anfang oder Ende einer Fahrt und Muster, die sich bei 3 oder mehr Fahrten wiederholen, sind Fahrplan und keine Maßnahme | 0,8 / 0,6 |
| `pendel` | `cut`: mindestens 2 und mindestens die Hälfte der abgefragten Fahrten einer Linie, die in einem 30-min-Fenster beginnen, sind am Anfang oder Ende gekürzt (entfallene Halte); `remark`: ein Hinweis enthält „Pendelverkehr“ | 0,7 |
| `sev_start`/`sev_end` | erster/letzter Schnappschuss einer SEV-Episode (Abschnitt 8), nur wenn Beginn bzw. Ende tatsächlich beobachtet wurden (`startObserved`/`endObserved`); Episoden, die schon zu Beginn der Aufzeichnung liefen, erzeugen keine Aktion | 0,9 |

Grenzen: `decidedS` ist nur so genau wie die Abfragedichte (Tafeln alle 4–30 min, Störungsfahrten alle 5 min), und ein großer Teil der Ausfälle ist schon sichtbar, wenn eine Fahrt zum ersten Mal auf einer Tafel erscheint (`censored`). Halten und Taktregulierung sind aus minutengenauen Zeiten nur grob erkennbar. Kurzwenden und Umnummerierungen werden heuristisch zugeordnet. Ein Vergleich mit derselben Linie eine Woche vorher, um planmäßige Muster noch sicherer auszuschließen, ist nicht eingebaut; über mehrere Exporte lässt er sich mit `recurring` und `network.turnStations` nachbilden. Die Ursache einer Maßnahme steht nur indirekt in `disruptions`.

**incidents** (betriebliche Sicherheits-Proxys): `type`, `line`, `station` oder `segment`, `fromS`, `toS`, `confidence`, `tripId`.

| type | Regel | Konfidenz |
|---|---|---|
| `stall` | Ist-Fahrzeit eines Abschnitts > Soll + 180 s (0,7), oder Radar-Position bewegt sich mindestens 3 min weniger als 30 m, mehr als 250 m von jedem Bahnhof entfernt (0,5, mit `lat`/`lon`) | 0,7 / 0,5 |
| `crowd_gap` | Auslastung `high` und Abstand > 1,5 × Soll-Takt | 0,6 |
| `bunching` | Folge von `bunch`-Abständen einer Linie und Richtung, Pausen bis 15 min, mit Anzahl `n` | 0,6 |

## 10. Kennzahlen und Reward

`kpis` liefert je 5 min, Linie und Richtung (nur abgedeckte Minuten, primäre Halte):

- **Pünktlichkeit** `punct1`, `punct4`, `punct6`: Anteil der gemessenen Ankünfte mit Verspätung unter 60, 240 und 360 s. `punct4` entspricht der Berliner Regel „bis 3:59 min pünktlich“.
- **Ausfälle** `cancelledTrips`, `cancelledStops`.
- **Zusätzliche Wartezeit** `ewtS`: Σh²/(2Σh) der Ist-Abstände minus derselbe Wert der Soll-Abstände, in Sekunden. Das ist die mittlere Mehrwartezeit eines zufällig ankommenden Fahrgasts.
- **Taktstabilität** `headwayCv`, `bunching`, `gaps`, wie `ewtS` nur aus gemessenen Abständen (`headways.rt`). Bei Linien mit wenig Echtzeit (`meta.rtShare`) sind `headwayCv` und `ewtS` daher oft `null` (unbekannt, nicht stabil), und `bunching`/`gaps` zählen nur die gemessenen Abstände.
- **Sicherheits-Proxys** `stalls`, `crowdGap`.
- **Fahrgastverspätung** `paxDelayS`: Summe positiver Verspätungen mal Auslastungsgewicht (`low` 1, `medium` 2, `high` 3, unbekannt 1).
- **Abdeckung** `coverage`: Fenster mit `coverage < 1` haben weniger Ankünfte, weil Minuten fehlen; für Raten (`punct*`) ist das unkritisch, für Summen sollte man gewichten oder maskieren.

Vorschlag für einen Reward je Schritt und Linie (Gewichte anpassen):

```
r = − 1,0 · ewtS/60 − 0,5 · paxDelayS/600 − 3 · cancelledTrips − 0,5 · cancelledStops
    − 2 · bunching − 2 · gaps − 5 · stalls − 3 · crowdGap + 2 · punct4
```

Maßnahmen selbst sollten kleine Kosten haben (`cancel` und `short_turn` höher als `hold`), damit das Modell nicht unnötig eingreift. Empfehlungen an Bahnhöfen ohne Eintrag in `network.turnStations` oder mit Abständen unter `network.minHeadways` sollten als nicht machbar bestraft oder ausgeschlossen werden.

## 11. Training

- **Episode** = ein Betriebstag, **Schritt** = 60 s (`snapshots.t`, `lineState.t`). Nur abgedeckte Minuten sind enthalten; fehlende Minuten sind Lücken und keine ruhigen Phasen.
- **Zustand** zum Zeitpunkt t: nur Felder, die zu t bekannt waren. **Leakage-Regel:** Die folgende Tabelle trennt erlaubte Zustandsfelder von Labels, die die Wahrheit im Rückblick enthalten und nur als Ziel oder Reward dienen dürfen.

| Tabelle | Zustand (zu t bekannt) | nur Label/Reward (Rückblick) |
|---|---|---|
| `snapshots` | `knownDelayS`, `observed`, `stoppedS`, `line`, `dirTo` | `lat`, `lon`, `fromStation`, `toStation`, `frac`, `atStation`, `delayS`, `leaderGapS`, `followerGapS` (aus endgültigen Ist-Zeiten interpoliert), `occupancy` (letzte Abfrage) |
| `lineState` | `observed`, `knownMeanDelayS`, `knownMaxDelayS`, `knownCancelledNext30`, `sevActive` | `active`, `meanDelayS`, `maxDelayS`, `headwayCv`, `bunching`, `gaps`, `cancelledNext30` |
| `forecasts` | `obsS`, `src`, `plannedS`, `predDelayS`, `horizonS` für `obsS ≤ t` | `finalDelayS`, `errS` |
| `stopEvents` | Sollzeiten, `plannedPlatform`; `cancelSeenS` nur für t ≥ `cancelSeenS` | `arrS`, `depS`, `*DelayS`, `dwellS`, `platform`, `cancelled`, `arrCancelled`, `depCancelled`, `rt` |
| `trips` | Sollzeiten, Linie, `firstSeenS` für t ≥ `firstSeenS` | `status`, `startS`, `endS`, `maxDelayS`, `endDelayS`, `nCancelled` |
| `disruptions` | Hinweise mit `firstSeenS ≤ t` | `lastSeenS`, `nTrips` |
| `actions` | – | alles; `decidedS`/`stateT` nur für t ≥ diesem Wert, `outcome` immer nur als Label |
| `context` | Kalender, `weather`/`forecast15` mit `tS ≤ t`, `alerts` mit Beginn ≤ t | – |
| `positions` | Rohpositionen mit `tS ≤ t` (besserer Ersatz für `snapshots.lat/lon`) | – |

  Ein zu t bekannter Abstand zum Vordermann lässt sich aus `positions` oder aus Sollzeiten plus `knownDelayS` schätzen; `leaderGapS` selbst ist Rückblick.
- **Aktionen** = `actions` mit `stateT` als Zeitpunkt. Die Ableitung ist unsicher; `confidence` als Gewicht nutzen, `censored`-Aktionen höchstens mit ihrem frühesten bekannten Zeitpunkt, und Aktionen mit `recurring ≥ 3` eher als Fahrplanzustand denn als Entscheidung behandeln.
- **Splits** nach Kalenderwochen (z. B. Wochen 1–6 Training, 7 Validierung, 8 Test), niemals zufällig über Zeilen oder Minuten, weil benachbarte Minuten fast identisch sind.
- **Verfahren:** offline, denn eingreifen kann das Modell nicht. Behavior Cloning auf `actions` als Ausgangspunkt, dann konservative Offline-RL-Verfahren wie CQL oder IQL mit dem Reward aus Abschnitt 10. Zusätzlich lohnt ein eigenes Prognosemodell auf `forecasts` (Ziel `finalDelayS`, Merkmal `horizonS`).
- **Simulator:** Fahrzeiten aus `runs` (Verteilung von `actualS` je Abschnitt, Tageszeit und Wetter), Haltezeiten aus `stopEvents.dwellS`, Wendezeiten aus `turnbacks` und `network.turnStations`, Mindestabstände aus `network.minHeadways` kalibrieren. Damit lassen sich Maßnahmen gegenfaktisch bewerten, bevor man sie empfiehlt.
- **Menge:** mindestens 8–12 Wochen aufzeichnen, damit Wochentage, Ferien, Wetter und seltene Störungen (Notarzteinsatz, Weichenstörung, Unwetter) mehrfach vorkommen.
- Minuten mit Lücken (`meta.coverage`, `meta.gaps`) sind schon ausgeschlossen; `snapshots.observed` zeigt, ob ein Zug in dieser Minute tatsächlich beobachtet wurde.

## 12. Bekannte Grenzen und Erweiterungen

- **Ring-Echtzeit:** BVG-HAFAS liefert für S41/S42 fast keine Verspätungen (Abschnitt 6). Die DB-Schnittstellen (z. B. `v6.db.transport.rest` oder die DB-Timetables-API mit Ursachen-Codes je Halt) führen die S-Bahn Berlin ebenfalls und sind die naheliegende zweite Quelle für den Ring; sie sind nicht angebunden und müssten auf ihre Echtzeitqualität geprüft werden.
- **Ursachen:** Die DB-Timetables-API würde auch Störungsursachen genauer machen; sie braucht einen API-Schlüssel.
- **GTFS-Soll:** Mit `--gtfs` wird der VBB-Fahrplan wöchentlich archiviert, aber nicht ausgewertet. Ein Abgleich mit dem HAFAS-Plan würde planmäßige von außerplanmäßigen Fahrten und Haltfolgen noch sicherer trennen.
- **Infrastruktur:** `network.turnStations` und `network.minHeadways` sind beobachtet, nicht amtlich: Ein Bahnhof ohne Eintrag kann trotzdem eine Kehranlage haben, und Mindestabstände sind minutengenau. Weichenverbindungen, Blockabstände, Abstellanlagen und Zuglängen fehlen. Eingleisige Abschnitte in `network.singleTrack` sind von Hand eingetragen und nicht geprüft.
- **Fahrzeugumläufe:** Nur angenähert über `trips.trainId` (gleicher physischer Zug), `turnbacks` (heuristische Wenden) und HAFAS-Hinweise „Verkehrt ab … als …“ in `disruptions`.
- **Veranstaltungen:** Großveranstaltungen (Fußball, Konzerte, Messen) erklären viel Fahrgastandrang. Sie müssen derzeit per `--events` beigesteuert werden.
- **Auslastung** gibt es fast nur bei der U-Bahn, und nur in drei Stufen.
- **Positionen** sind Schätzungen, und Ring-Positionen kommen überwiegend nur jede Minute.
- **Budget:** Bei 45 Anfragen pro Minute werden die übrigen Tafeln tagsüber etwa alle 18–21 min abgefragt, bei 30 etwa alle 35–50 min. Mehr Budget oder ein zweiter Rechner mit eigener IP verdichtet die Prognosebeobachtungen.
