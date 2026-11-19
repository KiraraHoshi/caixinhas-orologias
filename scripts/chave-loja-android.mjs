// Prepara o build da Google Play (roda na pasta do projeto, depois do "npx cap add android"):
// 1. assina o .aab com a chave de envio (android/caixinhas-envio.jks, posta pelo workflow a partir dos segredos do GitHub;
//    a senha e o apelido chegam pelas variáveis CX_CHAVE_SENHA e CX_CHAVE_ALIAS, nunca escritos em arquivo);
// 2. calcula o versionCode a partir da versão do index.html, para ele sempre crescer: (a*10000 + b*100 + c) * 10
//    (2.0.0 vira 200000; 2.0.1, 200010). O último dígito sobra para uma correção do mesmo número de versão, se um dia precisar.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function falhar(msg) { console.error(msg); process.exit(1); }
const arq = "android/app/build.gradle";
let g = readFileSync(arq, "utf8");
const m = readFileSync("index.html", "utf8").match(/const VERSION = '(\d+)\.(\d+)\.(\d+)';/);
if (!m) falhar("Versão não encontrada no index.html (const VERSION = 'a.b.c';)");
const [a, b, c] = m.slice(1).map(Number), versao = `${a}.${b}.${c}`;
if (b > 99 || c > 99) falhar(`Versão ${versao}: o meio e o fim precisam ficar abaixo de 100 para o versionCode crescer sempre`);
const codigo = (a * 10000 + b * 100 + c) * 10;
const chave = resolve("android/caixinhas-envio.jks").replace(/\\/g, "/");
const bloco = `
    signingConfigs {
        loja {
            storeFile file("${chave}")
            storePassword System.getenv("CX_CHAVE_SENHA")
            keyAlias System.getenv("CX_CHAVE_ALIAS")
            keyPassword System.getenv("CX_CHAVE_SENHA")
        }
    }
`;
if (g.includes("signingConfigs")) falhar("O build.gradle já tem signingConfigs: o pacote da loja não pode passar pelo chave-teste-android.mjs");
if (!/android\s*\{/.test(g) || !/buildTypes\s*\{\s*release\s*\{/.test(g)) falhar("android { } ou buildTypes { release { } } não encontrado em " + arq);
if (!/versionCode \d+/.test(g) || !/versionName "[^"]*"/.test(g)) falhar("versionCode ou versionName não encontrado em " + arq);
g = g.replace(/android\s*\{/, (x) => x + bloco);
g = g.replace(/buildTypes\s*\{\s*release\s*\{/, (x) => x + `\n            signingConfig signingConfigs.loja`);
// no ensaio (CX_ENSAIO=1, chave descartável) o nome da versão termina em "-ensaio": o .aab nunca se confunde com o de verdade
const nome = process.env.CX_ENSAIO === "1" ? versao + "-ensaio" : versao;
g = g.replace(/versionCode \d+/, `versionCode ${codigo}`).replace(/versionName "[^"]*"/, `versionName "${nome}"`);
writeFileSync(arq, g);
console.log(`Orolon Caixinhas ${nome} (versionCode ${codigo})`);
