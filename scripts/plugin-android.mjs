// Ajusta o projeto Android gerado pelo Capacitor ("npx cap add android"), rodando na pasta do projeto (a que tem android/):
// 1. copia o plugin "Caixinhas" e o widget "Lançar gasto" (android-plugin/) para o pacote do app;
// 2. MainActivity: registra o plugin e faz o toque no widget valer uma vez;
// 3. copia os recursos de android-assets/res/ (widget, ícone da notificação) para res/;
// 4. manifesto: registra o widget e tira a permissão de internet;
// 5. APK de teste (sem CX_LOJA=1): identificador com ".teste" e nome "Orolon Caixinhas (teste)", para conviver com o da loja.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url)); // de onde vêm o plugin e os recursos
const LOJA = process.env.CX_LOJA === "1";
const raiz = "android/app/src/main/java";
function achar(dir, nome) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { const r = achar(p, nome); if (r) return r; }
    else if (f === nome) return p;
  }
  return null;
}
function falhar(msg) { console.error(msg); process.exit(1); }
const main = achar(raiz, "MainActivity.java");
if (!main) falhar("MainActivity.java não encontrada em " + raiz);
const pacote = (readFileSync(main, "utf8").match(/^package\s+([\w.]+);/m) || [])[1];
if (!pacote) falhar("Pacote da MainActivity não encontrado");

// 1. plugin e widget
const pasta = main.replace(/MainActivity\.java$/, "");
for (const f of ["CaixinhasPlugin.java", "LancarWidget.java"]) {
  const fonte = readFileSync(join(REPO, "android-plugin", f), "utf8");
  if (!fonte.includes("package PACOTE;")) falhar(f + " sem a linha 'package PACOTE;'");
  writeFileSync(pasta + f, fonte.replace("package PACOTE;", `package ${pacote};`));
}

// 2. MainActivity: registra o plugin antes de o Capacitor iniciar.
//    As barras do sistema ficam como na 1.9 (SystemBars "css" no capacitor.config.json, sem EdgeToEdge): o conserto do
//    Orolon Player (native + EdgeToEdge) deu defeito num celular de verdade em 19/11/2026 e só vem para cá depois de provado lá.
//    O toque no widget (caixinhas://lancar) vale uma vez: se o Android recria a tela (app reaberto pelos recentes,
//    ou restaurado depois de fechado para liberar memória), o endereço sai antes de o Capacitor lê-lo.
writeFileSync(main, `package ${pacote};

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        Intent pedido = getIntent();
        Uri endereco = pedido != null ? pedido.getData() : null;
        if (endereco != null && "caixinhas".equals(endereco.getScheme())
                && (savedInstanceState != null || (pedido.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0)) {
            pedido.setData(null);
        }
        registerPlugin(CaixinhasPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

// 3. recursos: layout, prévia e dados do widget, fundos, textos e o ícone da notificação (res/drawable/ic_notif.xml,
//    citado em LocalNotifications.smallIcon no capacitor.config.json)
cpSync(join(REPO, "android-assets", "res"), "android/app/src/main/res", { recursive: true });

// 4. manifesto
const arq = "android/app/src/main/AndroidManifest.xml";
let xml = readFileSync(arq, "utf8");
// o widget: o Android manda as atualizações ao receiver pelo próprio sistema, então ele não precisa ficar aberto a outros apps
if (!xml.includes('android:name=".LancarWidget"')) {
  if (!/<\/application>/.test(xml)) falhar("</application> não encontrado no manifesto");
  xml = xml.replace(/(\s*)<\/application>/, `
        <receiver
            android:name=".LancarWidget"
            android:exported="false"
            android:label="@string/widget_lancar_nome">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/widget_lancar" />
        </receiver>$1</application>`);
}
// o app não usa a internet: a permissão que o Capacitor põe por padrão sai do manifesto.
// (tools:node="remove" também vale para o que as bibliotecas tentarem acrescentar)
if (process.env.CX_COM_INTERNET !== "1") {
  if (!xml.includes("xmlns:tools")) xml = xml.replace("<manifest", '<manifest xmlns:tools="http://schemas.android.com/tools"');
  xml = xml.replace(/\s*<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/g, "");
  const tirarInternet = /<uses-permission android:name="android\.permission\.INTERNET" tools:node="remove"\s*\/>/;
  if (!tirarInternet.test(xml)) xml = xml.replace(/(\s*)<application/, `\n    <uses-permission android:name="android.permission.INTERNET" tools:node="remove" />\n$1<application`);
}
writeFileSync(arq, xml);

// 5. APK de teste ao lado do da loja: outro identificador (com.joah.caixinhas.teste) e outro nome na tela.
//    O que depende do identificador acompanha sozinho: o FileProvider usa ${applicationId} no manifesto e
//    getPackageName() no plugin; a pasta do backup e o widget são de cada app instalado.
if (!LOJA) {
  const gradle = "android/app/build.gradle";
  let g = readFileSync(gradle, "utf8");
  if (!g.includes("applicationIdSuffix")) {
    if (!/defaultConfig\s*\{/.test(g)) falhar("defaultConfig não encontrado em " + gradle);
    g = g.replace(/defaultConfig\s*\{/, (m) => m + `\n        applicationIdSuffix ".teste"`);
  }
  writeFileSync(gradle, g);
  const nomes = "android/app/src/main/res/values/strings.xml";
  if (!existsSync(nomes)) falhar(nomes + " não encontrado: sem ele o APK de teste não ganha o (teste) no nome");
  let s = readFileSync(nomes, "utf8");
  s = s.replace(/(<string name="(?:app_name|title_activity_main)">)([^<]*?)(?: \(teste\))?(<\/string>)/g, "$1$2 (teste)$3");
  // o nome de teste é o que diferencia os dois apps na tela: se o formato do strings.xml mudou, parar aqui
  if (!/<string name="app_name">[^<]* \(teste\)<\/string>/.test(s)) falhar("Não deu para pôr o (teste) no app_name de " + nomes);
  writeFileSync(nomes, s);
}

console.log(`Plugin Caixinhas e widget ligados em ${pacote}${LOJA ? " (pacote da loja)" : " (APK de teste: identificador com .teste)"}`);
console.log((xml.match(/<uses-permission[^>]*>/g) || []).join("\n"));
