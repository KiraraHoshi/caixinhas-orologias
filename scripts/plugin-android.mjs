// Liga o plugin "Caixinhas" (android-plugin/CaixinhasPlugin.java) ao projeto Android gerado pelo Capacitor:
// 1. copia o plugin para o pacote do app; 2. registra o plugin na MainActivity; 3. tira a permissão de internet.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const raiz = "android/app/src/main/java";
function achar(dir, nome) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { const r = achar(p, nome); if (r) return r; }
    else if (f === nome) return p;
  }
  return null;
}
const main = achar(raiz, "MainActivity.java");
if (!main) { console.error("MainActivity.java não encontrada em " + raiz); process.exit(1); }
const pacote = (readFileSync(main, "utf8").match(/^package\s+([\w.]+);/m) || [])[1];
if (!pacote) { console.error("Pacote da MainActivity não encontrado"); process.exit(1); }

// 1. plugin
const pasta = main.replace(/MainActivity\.java$/, "");
writeFileSync(pasta + "CaixinhasPlugin.java", readFileSync("android-plugin/CaixinhasPlugin.java", "utf8").replace("package PACOTE;", `package ${pacote};`));

// 2. MainActivity: registra o plugin antes de o Capacitor iniciar
writeFileSync(main, `package ${pacote};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CaixinhasPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

// 3. o app não usa a internet: a permissão que o Capacitor põe por padrão sai do manifesto.
//    (tools:node="remove" também vale para o que as bibliotecas tentarem acrescentar)
const arq = "android/app/src/main/AndroidManifest.xml";
let xml = readFileSync(arq, "utf8");
if (process.env.CX_COM_INTERNET !== "1") {
  if (!xml.includes("xmlns:tools")) xml = xml.replace("<manifest", '<manifest xmlns:tools="http://schemas.android.com/tools"');
  xml = xml.replace(/\s*<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/g, "");
  xml = xml.replace(/(\s*)<application/, `\n    <uses-permission android:name="android.permission.INTERNET" tools:node="remove" />\n$1<application`);
}
writeFileSync(arq, xml);
console.log("Plugin Caixinhas ligado em " + pacote);
console.log((xml.match(/<uses-permission[^>]*>/g) || []).join("\n"));
