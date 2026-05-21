# ⚡ Energietracker

Zählerstandsverwaltung für Strom, Gas und Wasser – für mehrere Mietobjekte.

## Features

- **Mehrere Objekte** – Verwalte beliebig viele Mietobjekte / Liegenschaften
- **Zählertypen** – Strom (kWh), Gas (m³), Wasser (m³) pro Objekt
- **Ablesungen** – Zählerstände mit Datum erfassen, Verbrauch wird automatisch berechnet
- **Tarifverwaltung** – vollständige Kostenstruktur je Zähler:
  - Arbeitspreis (ct/kWh oder €/m³)
  - Grundpreis (€/Monat)
  - Netzentgelt Arbeit & Grundpreis
  - Messstellenentgelt
  - Abwasser/Entsorgung (Wasser)
  - Sonstige Umlagen (KWK, §19 etc.)
  - Mehrwertsteuer
  - Gültigkeitszeitraum (automatische Tarifauswahl!)
- **Kostenabrechnung** – Brutto-Kosten für beliebigen Zeitraum berechnen
- **Dashboard** – Übersicht aller aktuellen Zählerstände

## Start

```bash
docker compose up -d
```

Dann aufrufen: http://localhost:3000

## Datenpersistenz

Die SQLite-Datenbank wird im Docker-Volume `energietracker_data` gespeichert
und überlebt Container-Neustarts und Updates.

## Update

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

## Backup

```bash
docker run --rm -v energietracker_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/energietracker_backup_$(date +%Y%m%d).tar.gz /data
```

## Andere Ports

In `docker-compose.yml` die Zeile `"3000:3000"` auf den gewünschten Port ändern,
z.B. `"8080:3000"` für Port 8080.
