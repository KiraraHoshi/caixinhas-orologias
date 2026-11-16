// Faz o APK de teste usar sempre a mesma chave (android-teste/teste-debug.keystore),
// para cada versão nova instalar por cima da anterior.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const arq = "android/app/build.gradle";
let g = readFileSync(arq, "utf8");
const loja = resolve("android-teste/teste-debug.keystore").replace(/\\/g, "/");
const bloco = `
    signingConfigs {
        debug {
            storeFile file("${loja}")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
`;
if (!g.includes("signingConfigs")) g = g.replace(/android\s*\{/, (m) => m + bloco);
g = g.replace(/buildTypes\s*\{/, (m) => m + `\n        debug {\n            signingConfig signingConfigs.debug\n        }`);
writeFileSync(arq, g);
console.log(g.slice(0, 1600));
