# Stromrechner

Webbasierte UI (Docker), die den Verbrauch und die Kosten einer Home-Assistant-Steckdose
für einen frei wählbaren Zeitraum berechnet und mit dem Gesamtverbrauch vergleicht.

## Start

```bash
docker compose up -d --build
```

Dann `http://localhost:8723` öffnen. Daten liegen im Volume `/data` (`db.json`).
Zeitzone per `TZ` in `docker-compose.yml` anpassen.

## Einrichtung
Einstellungen (Header oben rechts): Strompreis, Home-Assistant-URL, Long-Lived Token und die
Entitäten für Leistung (W, Pflicht), Spannung (V) und Stromstärke (A). Der Verbrauch wird aus den
Mittelwerten der HA-Statistik (5 Minuten, ältere Daten stündlich) über die Zeit integriert;
ohne Statistik fällt er auf den Zustandsverlauf zurück. Ohne Ende-Datum läuft der Zeitraum bis „jetzt“ weiter.
Frühere Gesamtverbräuche (kWh) lassen sich hinterlegen und dienen als Vergleich für den Prozentanteil.
