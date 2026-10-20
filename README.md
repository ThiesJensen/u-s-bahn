# Takt – S- und U-Bahn Berlin live

Interaktive, dreidimensionale Karte des Berliner S- und U-Bahn-Netzes mit Live-Abfahrten, Live-Zügen und echten Gleishöhen. Läuft komplett im Browser, ohne eigenes Backend und ohne API-Schlüssel.

## Funktionen

- 3D-Ansicht „Real“ mit echten Höhen: Gebäude in ihrer Höhe, jedes Gleis auf seiner Höhe aus OpenStreetMap, U-Bahn im Tunnel unter dem Boden, S-Bahn auf Damm, Viadukt oder im Tunnel, Hochbahnen wie U1 und U2 oben, Bahnsteige als Körper in ihrer Tiefe, Schächte zur Straße und zwischen übereinanderliegenden Bahnsteigen, Live-Züge auf ihrer Gleishöhe
- 3D-Ansicht „Schema“ mit drei Ebenen: Stadt unten, U-Bahn darüber, S-Bahn ganz oben, verbunden durch Lichtschächte
- Klassische flache Karte über den Umschalter 2D/3D
- Landesgrenzen: Berlin deutlich hervorgehoben, die Außengrenze Brandenburgs zurückhaltender, beide entlang der Linie beschriftet und in allen Ansichten auf dem Boden gezeichnet
- Tarifzonen Berlin A, B und C als zarte Flächen mit Zonengrenzen und großen Buchstaben, dazu die Zone jedes Bahnhofs in der Abfahrtstafel und in der Suche
- Liniennetz in offiziellen Linienfarben, parallele Linien auf gemeinsamen Strecken, Beschriftungen ohne Überlappung auch an dichten Knoten
- Abfahrtstafel pro Bahnhof mit Countdown, Verspätung, Gleis, Ausfällen und Störungshinweisen, alle 30 Sekunden aktualisiert
- Fahrtverlauf mit allen Halten und Verspätungen, Strecke auf der Karte hervorgehoben
- Linienansicht mit allen Bahnhöfen und Umstiegen
- Live-Züge auf der Karte, flüssig animiert, mit einer kleinen weißen Spitze in Fahrtrichtung; Züge, die gerade halten, als Ring in Linienfarbe um den Bahnhof
- Suche nach Bahnhöfen und Linien, Deep Links wie `#s=900100003` oder `#l=U8`
- Helles und dunkles Design, optimiert für Desktop, Tablet und Smartphone im Hoch- und Querformat

## Bedienung

**Kamera.** Alle Achsen lassen sich frei steuern:

- Maus: ziehen verschiebt, Rad zoomt, mit rechter Maustaste oder Strg ziehen dreht und neigt
- Trackpad: zwei Finger verschieben, Aufziehen zoomt, Shift und zwei Finger drehen und neigen, in Safari dreht auch die Drehgeste
- Touch: zwei Finger zoomen und drehen, beide Finger gemeinsam hoch oder runter ziehen neigt
- Tastatur: Pfeiltasten verschieben, Shift und Pfeiltasten drehen und neigen, `+` und `-` zoomen, `/` öffnet die Suche, `Esc` schließt
- Unten rechts: Neigungsregler, Kompass (klicken richtet nach Norden aus, ziehen dreht und neigt), Zoom, Ansicht zurücksetzen und `?` mit allen Gesten
- Blickwinkel „Von oben“, „Schräg“ und „Untergrund“; der Untergrund-Blick schaut von unten auf Tunnel und Bahnhöfe

Die Neigung hält zunächst am Horizont an. Wer in derselben Geste ein Stück weiterneigt, taucht unter den Boden; das geht nur in „Real“, „Untergrund“ schaltet bei Bedarf dorthin um.

**Ebenen.** Das Symbol oben rechts öffnet das Ebenen-Panel:

- Augen blenden S-Bahn, U-Bahn und Stadt ein und aus, die Linienschilder öffnen die Linienansicht
- „Live-Züge“ zeigt die Züge im Ausschnitt
- „Grenzen“ zeigt die Landesgrenzen von Berlin und Brandenburg (anfangs an)
- „Tarifzonen“ zeigt die Zonen A, B und C mit kleiner Legende (anfangs aus)
- „Real“ oder „Schema“ wählt die 3D-Darstellung
- „Durchsicht“ macht Boden und Gebäude durchsichtig, „Höhen“ überhöht Gebäude und Gleise gemeinsam bis 3× (nur Real)
- „Abstand“ zieht die Ebenen von flach bis explodiert auseinander, auch mit den Tasten `[` und `]` (nur Schema)

## Daten und Quellen

- Echtzeitdaten: öffentliche BVG-Schnittstelle [v6.bvg.transport.rest](https://v6.bvg.transport.rest)
- Basiskarte: OpenFreeMap, OpenMapTiles und OpenStreetMap
- Gleishöhen und Bahnsteige (`public/data/tracks3d.json`) sowie Landesgrenzen (`public/data/boundaries.json`, Relationen 62422 und 62504): © OpenStreetMap-Mitwirkende, [ODbL](https://opendatacommons.org/licenses/odbl/)
- Tarifzonen (`public/data/zones.json`): Zuordnung der Gemeinden und Bahnhöfe nach dem VBB-Verzeichnis „VBB-Tarif: Alle Zielorte 2026“, Flächen aus OpenStreetMap-Grenzen (ODbL). A ist das Gebiet innerhalb des S-Bahn-Rings, B reicht bis zur Stadtgrenze, C umfasst das Umland mit Potsdam und dem Flughafen BER
- Gezeichnet wird mit MapLibre und deck.gl

## Starten

Voraussetzung ist Node.js 22 oder neuer.

```bash
npm install
npm run data
npm run dev
```

`npm run build` baut die statische Seite nach `dist/`.

## Daten neu bauen

`npm run data` erzeugt das Liniennetz in `public/data/network.json`. Dafür fragt das Skript die Abfahrten am nächsten Dienstag um 11, 16 und 20 Uhr sowie am nächsten Samstag um 11 Uhr ab, also immer den aktuellen Fahrplan. Antworten landen in `scripts/.cache`; nicht mehr benötigte Einträge werden nach jedem Lauf entfernt. Schlägt eine Anfrage fehl oder fehlt danach eine Linie, bleibt die bestehende Datei unverändert. Ruht eine Linie absichtlich für längere Zeit, schreibt `FORCE=1 npm run data` die Datei trotzdem.

Die Gleishöhen in `public/data/tracks3d.json` baut `scripts/build-tracks3d.py` aus den OpenStreetMap-Extrakten von Berlin und Brandenburg, zum Beispiel von Geofabrik. Das Skript braucht Python 3 mit dem Paket `osmium` und liest das Liniennetz aus `network.json`, läuft also nach `npm run data`:

```bash
pip install osmium
python3 scripts/build-tracks3d.py berlin-latest.osm.pbf brandenburg-latest.osm.pbf
```

Wo Linien zwischen zwei Bahnhöfen auf verschiedenen Gleisen fahren, entstehen getrennte Abschnitte. Teilen sich solche Abschnitte später doch ein Gleis, schreibt das Skript einen seitlichen Versatz (`shift`) mit, damit die Linien dort als Bündel nebeneinander liegen. Kreuzen sich Tunnel mit weniger als 5 m Höhenabstand, senkt es die untere Strecke ab oder hebt die obere an, mit höchstens 4 % Steigung und ohne die Bahnsteighöhen zu verändern. Eine ebenerdige Strecke sinkt dabei höchstens auf Einschnitttiefe. Laufen zwei Tunnel an einem gemeinsamen Bahnhof übereinander, bestimmen die Bahnsteighöhen, welcher oben liegt. Kurze Tunnel zwischen zwei Einschnitten, etwa unter Straßenbrücken, gelten als überdeckter Einschnitt.

## Betrieb aufzeichnen

`npm run record` zeichnet den laufenden Betrieb aller S- und U-Bahn-Linien dauerhaft nach `recordings/` auf: Positionen alle 30 Sekunden, Abfahrtstafeln, vollständige Fahrtverläufe mit Ist-Zeiten, Ausfällen und Gleiswechseln, den Soll-Fahrplan sowie Wetter, Unwetterwarnungen und Ferien. `npm run export -- --from 2026-10-20 --to 2026-10-26 --gzip` macht daraus Trainingstabellen nach `exports/`. Auf dem Mac am besten mit `caffeinate -i npm run record` starten. Aufbau, Schemas und Grenzen der Daten stehen in [`docs/DATENSATZ.md`](docs/DATENSATZ.md).
