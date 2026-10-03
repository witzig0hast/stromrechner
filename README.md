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

## E-Mail-Warnungen
Unter Einstellungen → E-Mail-Benachrichtigung SMTP-Daten eintragen (direktes TLS, Port 465, kein STARTTLS).
Täglich zur eingestellten Uhrzeit wird geprüft:
- gestern gegen den Durchschnitt der 7 Tage davor
- laufender Monat (an den ersten beiden Tagen der Vormonat) gegen den Durchschnitt der 3 Monate davor

Bei Überschreitung der Schwellen (Prozent und Mindest-Mehrverbrauch) geht eine E-Mail raus. Die Ursachenanalyse
(Grundlast, Laufzeit, Spitzenleistung, Zeitfenster) ist regelbasiert, ohne KI.
