// Monta a pasta www/ com os arquivos do app para o Capacitor (o mesmo app do site, sem o service worker).
import { cpSync, mkdirSync, rmSync } from "node:fs";
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const item of ["index.html", "manifest.webmanifest", "privacy.html", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) cpSync(item, "www/" + item);
// O service worker não entra: no app Android tudo já vem dentro do aplicativo (o index.html não o registra quando window.Capacitor existe).
console.log("www/ pronta");
