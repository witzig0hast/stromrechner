# Stromrechner

Webbasierte UI (Docker), die den Verbrauch und die Kosten einer Home-Assistant-Steckdose
für einen frei wählbaren Zeitraum berechnet und mit dem Gesamtverbrauch vergleicht.

## Start

```bash
docker compose up -d --build
```

Dann `http://localhost:8723` öffnen. Beim ersten Start steht ein **Einrichtungscode** im Log
(`docker compose logs stromrechner`); damit legst du im Browser das Passwort fest (oder du setzt `ADMIN_PASSWORD`). Daten liegen im Volume `/data` (`db.json`).
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
Die Auswertung lädt sofort beim Öffnen. Zeitraum per Schnellwahl (Heute, 7 Tage, 30 Tage, Dieser Monat,
Dieses Jahr) oder „Eigener Zeitraum“; läuft der Zeitraum bis „jetzt“, aktualisiert sich die Seite jede Minute.

## Sicherheit
- Pflicht-Login (scrypt-Passwort-Hash, Sitzungs-Cookie `HttpOnly` + `SameSite=Strict`, `Secure` unter HTTPS),
  Sperre nach 5 Fehlversuchen (15 Min.), Erst-Einrichtung nur mit Code aus dem Log
- CSRF-Token + Origin-Prüfung bei allen schreibenden Anfragen
- Strenge CSP (kein Inline-Script/-Style), `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer`
- Geheimnisse (HA-Token, SMTP-Passwort) werden nie an den Browser gesendet; bei geänderter URL/Server müssen sie
  neu eingegeben werden, damit sie nicht an fremde Hosts gehen
- Eingabevalidierung (URL, Entitäten, Datum, E-Mail), Größen- und Zeitraumlimits, Rate-Limit
- Container: Non-Root, read-only Dateisystem, alle Capabilities entfernt, `no-new-privileges`, Ressourcenlimits
- Daten liegen in `/data/db.json` (Rechte 0600) – das Volume wie ein Geheimnis behandeln (Backups!).

Für Zugriff über das Internet: HTTPS-Reverse-Proxy (z. B. Caddy/Traefik/nginx) davorsetzen. Proxys werden automatisch erkannt
(`X-Forwarded-For/-Proto/-Host` werden akzeptiert, wenn die Verbindung von einer privaten/lokalen Adresse kommt;
`TRUST_PROXY=1` erzwingt es, `0` schaltet es ab). Der Proxy sollte `X-Forwarded-Proto` setzen, damit der Cookie `Secure` wird.
Ohne HTTPS wird das Passwort im Klartext übertragen – nur im vertrauenswürdigen Heimnetz betreiben.
