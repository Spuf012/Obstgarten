# Obstgarten

Web-App für den Obstgarten : Lageplan der Bäume, Schnitt und Pflanzenschutz, Ertrag und Erzeugnisse (Saft, Gelee, …) sowie Apfelwein-Gärbehälter.

- **App:** https://spuf012.github.io/Obstgarten/ (Anmeldung mit E-Mail und Passwort)
- **Daten:** Supabase (Projekt „MealPlan“, Tabellen `og_docs` und `og_members`), Zugriff nur für freigeschaltete Personen
- **Code:** `src/obstgarten.html` ist die App, `host.js` verbindet sie mit Supabase und regelt die Anmeldung. `index.html` wird mit `python3 build.py src/obstgarten.html` erzeugt.

Auf dem iPhone/iPad: Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Auf dem Mac: Safari → Ablage → „Zum Dock hinzufügen“.
