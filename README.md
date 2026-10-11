# Ascandir - Persistent Thrown Weapons/Items

Foundry VTT Modul für **dnd5e 6.x** (getestet gegen Foundry v14.368 / dnd5e 6.0.6).

Geworfene Waffen verschwinden nicht mehr einfach:

- **Wurf-Animation** – Speere fliegen mit der Spitze voraus, Äxte und Hämmer drehen sich, Dolche wirbeln schnell. Alle Spieler sehen die Animation.
- **Treffer** – die Waffe bleibt im Gegner stecken: Sie wandert in sein Inventar (kann also nach dem Tod gelootet werden, z. B. mit Corpse Loot) und ist als kleines Symbol am Token zu sehen.
- **Herausziehen** – Doppelklick auf das steckende Symbol (mit eigenem Token in Reichweite). Das zählt als Angriff mit der Waffe: Angriffswurf gegen die RK, bei Treffer Schadenswurf (Schaden wird automatisch angewendet, abschaltbar). Die Waffe landet im Inventar des Herausziehenden.
- **Fehlwurf** – die Waffe landet als kleines Token in der Nähe des Ziels auf dem Boden. **Patzer (natürliche 1)** – sie fliegt deutlich weiter weg.
- **Aufheben** – Doppelklick auf die liegende Waffe (eigenen Token in Reichweite ausgewählt). Hatte der Charakter die Waffe vorher, wird der Stapel einfach wieder aufgefüllt.
- **Alle Waffen werfbar** – Nahkampfwaffen ohne die Eigenschaft „Wurfwaffe“ bekommen im Angriffsdialog den Modus „Geworfen (improvisiert)“. Außerdem zählt ein Nahkampfangriff auf ein Ziel außerhalb der Reichweite automatisch als Wurf.
- **Ausgenommen**: Munition und Waffen mit Munition (Bögen, Armbrüste, Schleudern) sowie Darts/Wurfpfeile (Liste in den Einstellungen anpassbar). Waffen mit der Eigenschaft „Zurückkehrend“ fliegen hin und zurück und bleiben nicht liegen.

## Ablauf am Tisch

1. Ziel anvisieren (Taste T), dann normal mit der Waffe angreifen und im Angriffsdialog „Geworfen“ wählen.
2. Treffer → Waffe steckt im Gegner. Fehlwurf → Waffe liegt am Boden.
3. Zum Aufheben/Herausziehen den eigenen Token auswählen und doppelt auf die Waffe klicken.

Ein Spielleiter muss online sein, damit Waffen liegen bleiben bzw. stecken können.

## Installation

Manifest-URL in Foundry unter *Module installieren*:

```
https://github.com/Ascandir/Ascandir---Persistent-Thrown-Weapons-Items/releases/latest/download/module.json
```

## Einstellungen

Alle Einstellungen findest du unter *Spieleinstellungen → Module konfigurieren → Ascandir - Persistent Thrown Weapons/Items* (Reichweiten, Streuung, Größen, Flugstile per Stichwort, Chat-Meldungen, Animation pro Client).
