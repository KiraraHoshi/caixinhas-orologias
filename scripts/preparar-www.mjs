// Monta a pasta www/ com os arquivos do app para o Capacitor (o mesmo app do site, sem o service worker).
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const item of ["index.html", "manifest.webmanifest", "privacy.html", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "fontes"]) cpSync(item, "www/" + item, { recursive: true });
// O service worker não entra: no app Android tudo já vem dentro do aplicativo (o index.html não o registra quando window.Capacitor existe).
const LOJA = process.env.CX_LOJA === "1";
if (LOJA) { // pacote da Google Play: o app fica sabendo que é a versão da loja (DA_LOJA)
  const f = "www/index.html", a = readFileSync(f, "utf8"), marca = "const DA_LOJA = false;";
  if (a.split(marca).length !== 2) { console.error("Não achei a marca do pacote da loja (const DA_LOJA = false;) uma vez só no index.html"); process.exit(1); }
  writeFileSync(f, a.replace(marca, "const DA_LOJA = true;"));
}
console.log("www/ pronta" + (LOJA ? " (pacote da Google Play)" : ""));
