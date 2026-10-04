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

## Dashboard
Die Auswertung lädt sofort beim Öffnen und zeigt standardmäßig **Gesamt** (alle Daten ab der ersten Messung,
mit Monatsdiagramm und Monatsübersicht). Zeitraum per Schnellwahl (Gesamt, Heute, 7 Tage, 30 Tage, Dieser Monat,
Dieses Jahr) oder „Eigener Zeitraum“; läuft der Zeitraum bis „jetzt“, aktualisiert sich die Seite jede Minute.

## Sicherheit und Verschlüsselung
- **Geheimnisse verschlüsselt:** HA-Token und SMTP-Passwort liegen in `/data/db.json` mit AES-256-GCM verschlüsselt.
  Schlüssel: `SECRET_KEY` (empfohlen) oder die automatisch erzeugte `/data/secret.key`. Ältere Klartext-Daten werden beim Start
  automatisch verschlüsselt. Passt der Schlüssel nicht, bricht die App ab, ohne etwas zu überschreiben.
- **Transport:** SMTP nur mit direktem TLS (Port 465). Für die Weboberfläche entweder HTTPS-Reverse-Proxy davorsetzen
  (wird automatisch erkannt: `X-Forwarded-*` gilt, wenn die Verbindung von einer privaten/lokalen Adresse kommt;
  `TRUST_PROXY=1|0` erzwingt/verbietet es) oder direktes HTTPS mit `TLS_CERT`/`TLS_KEY`.
- **Kein Login:** Die Oberfläche ist ohne Anmeldung erreichbar – betreibe sie nur im vertrauenswürdigen Netz oder hinter einem
  Proxy mit eigener Authentifizierung. Optional `ALLOWED_HOSTS` gegen DNS-Rebinding.
- Geheimnisse werden nie an den Browser gesendet; bei geänderter URL/Server müssen sie neu eingegeben werden.
- Schreibende Anfragen: JSON-Pflicht + Origin-Prüfung (CSRF). Strenge CSP, `X-Frame-Options`, `nosniff`.
- Eingabevalidierung (URL, Entitäten, Datum, E-Mail), Größen-/Zeitraumlimits, Rate-Limit.
- Container: Non-Root, read-only Dateisystem, keine Capabilities, `no-new-privileges`, Ressourcenlimits.
