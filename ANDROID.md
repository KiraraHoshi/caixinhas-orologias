# Orolon Caixinhas no Android

O app Android é o mesmo site (`index.html`), empacotado com o [Capacitor](https://capacitorjs.com). Tudo é montado no GitHub Actions; nada precisa ser instalado no PC.

## APK de teste (automático)

Cada envio, de qualquer branch, gera um APK de teste publicado em **Releases → Android (teste)**. A página diz de qual branch ele veio.
Ele é assinado com a chave fixa de `android-teste/`, então cada versão nova instala por cima da anterior.

Identificador do app: `com.joah.caixinhas` (não mudar: a Google Play trata outro identificador como outro app; **a confirmar** na Central de Ajuda do Play Console).

**APK de teste ao lado do app da loja (desde a 2.0):** o APK de teste tem o identificador `com.joah.caixinhas.teste` e se chama "Orolon Caixinhas (teste)", então os dois ficam instalados juntos, cada um com os seus dados, a sua pasta de backup e o seu widget. Mesmo apontando para a mesma pasta, o APK de teste tem marca própria nos backups (ver "Plugin próprio"), então um não apaga as cópias do outro. Quem decide é `scripts/plugin-android.mjs`: sem `CX_LOJA=1` ele põe `applicationIdSuffix ".teste"` no `build.gradle` e o "(teste)" no nome; com `CX_LOJA=1` (pacote da loja) não mexe em nada disso. O que depende do identificador acompanha sozinho (o FileProvider usa `${applicationId}` no manifesto e `getPackageName()` no plugin).
Os dados de um APK de teste anterior à 2.0 (`com.joah.caixinhas`) **não passam sozinhos** para o novo: exporte um backup no antigo e importe no novo.

As versões das bibliotecas ficam presas no `package-lock.json` (o workflow usa `npm ci`). Para atualizar o Capacitor: `npm install` no PC e commitar o `package-lock.json` novo.

## Versão da Google Play (.aab)

O pacote da loja é montado pelo workflow **App Android (loja)** (`.github/workflows/android-loja.yml`), que só roda quando você pede. Ele monta o projeto com `CX_LOJA=1` (identificador `com.joah.caixinhas`, sem o `.teste`, e o app fica sabendo que é o da loja pela marca `DA_LOJA` do `index.html`), assina o `.aab` com a **chave de envio** e falha se a permissão de internet aparecer no manifesto final. A chave nunca entra no repositório.

O `versionCode` sai da versão do `index.html`: `(a*10000 + b*100 + c) * 10`, então a 2.0.0 vira 200000 e a 2.0.1 vira 200010. Ele sempre cresce; para mandar uma atualização à loja, suba a versão antes, em todos estes lugares (o teste "Versão é a mesma em todo lugar" confere):

- `VERSION` no `index.html`;
- `CACHE` no `sw.js` (`caixinhas-v<versão>`);
- `version` no `package.json`;
- `version` no `package-lock.json`, duas vezes (no topo e no pacote raiz, `packages[""]`);
- o primeiro título do `CHANGELOG.md` (`## <versão>`);
- "Novidades da a.b" no `README.md`.

**Ensaio (sem a chave de verdade):** em Actions › "App Android (loja)" › Run workflow, marque **Ensaio**. O workflow cria uma chave descartável na hora e gera um `.aab` que só prova que a montagem funciona; o `versionName` dele termina em `-ensaio` e o arquivo se chama `Caixinhas-<versão>-ensaio.aab`. **Nunca envie o `.aab` do ensaio ao Play Console:** a chave descartável viraria a chave de envio registrada do app, e ela some quando o workflow termina.

### Criar a chave de envio (uma vez)

No PC, num terminal (o `keytool` vem com o Java; se o comando não for achado, ele fica na pasta `bin` do Java instalado):

```powershell
keytool -genkeypair -keystore caixinhas-envio.jks -storetype PKCS12 -alias caixinhas -keyalg RSA -keysize 2048 -validity 10000
```

Ele pede uma senha (anote num gerenciador de senhas) e um nome; o resto pode ficar em branco. Depois, transforme o arquivo em texto para o GitHub:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("caixinhas-envio.jks")) | Set-Content -NoNewline caixinhas-envio.base64.txt
```

Guarde o `caixinhas-envio.jks` e a senha **fora do repositório**, num lugar com backup. Não commite nenhum dos dois arquivos.

### Cadastrar os segredos no GitHub (uma vez)

No repositório: **Settings › Secrets and variables › Actions › New repository secret**:

- `CX_CHAVE_BASE64`: o conteúdo de `caixinhas-envio.base64.txt`
- `CX_CHAVE_SENHA`: a senha da chave
- `CX_CHAVE_ALIAS`: `caixinhas` (o `-alias` usado acima)

Depois de cadastrar, pode apagar o `caixinhas-envio.base64.txt`.

### Gerar o .aab

1. Na aba **Actions**, abra **App Android (loja)** e clique em **Run workflow**, na branch que vai para a loja (a `main`, depois de juntar a versão), com o Ensaio desmarcado.
2. No fim, o resumo do envio mostra a versão, o `versionCode` e as permissões que ficaram no app.
3. Baixe o `.aab` em **Artifacts** (`Caixinhas-<versão>-google-play`, guardado por 30 dias) e envie no Play Console.

Na primeira publicação, deixe ativado o **Play App Signing**: o Google guarda a chave final do app, e a chave de envio pode ser trocada se um dia se perder. Que ele vem ativado de fábrica e que a troca é feita pelo suporte é o que se sabe hoje (**a confirmar** na Central de Ajuda do Play Console).

**Quem já tem um APK de teste:**
- da 2.0 em diante (`com.joah.caixinhas.teste`, "Orolon Caixinhas (teste)"): o app da loja instala ao lado, sem apagar nada. Para levar os dados, exporte um backup no APK de teste e importe no app da loja.
- de antes da 2.0 (`com.joah.caixinhas`, o mesmo identificador da loja, mas assinado com a chave de teste): o Android não aceita atualizar um app com outra assinatura, então a Play **não deve instalar por cima** (**a confirmar** no celular). Antes: Ajustes › Backup e dados › Exportar backup (ou Enviar backup) e guarde o arquivo fora do app; depois desinstale o APK antigo, instale pela Play e importe o backup. Desinstalar sem backup apaga tudo.

## O que muda dentro do app

O `index.html` percebe que está no app (`window.Capacitor`) e só então:

- bloqueia o zoom de pinça e respeita a barra de status e a de navegação;
- faz o botão voltar fechar uma coisa por vez (folha de lançar, parte dos Ajustes, aba) e sair do app no Início;
- troca "baixar arquivo" pelo compartilhamento do Android (backup, planilha, tema);
- grava o backup automático numa pasta escolhida no seletor do Android;
- oferece lembretes de contas a vencer por notificação;
- manda a sobra do mês ao widget "Lançar gasto" a cada salvamento e abre a folha de lançar quando o app vem pelo toque nele;
- esconde o apoio pelo GitHub (links "Apoie o projeto" e a tela Apoie), que continua só no site.

## Barras do sistema

O app desenha de ponta a ponta em todo Android, como o Orolon Player 1.26.6: `SystemBars.insetsHandling: "native"` no `capacitor.config.json` e `EdgeToEdge.enable(this)` na `MainActivity` (posto pelo `scripts/plugin-android.mjs`). Em WebView 140 ou mais nova o Capacitor repassa o recuo das barras à página (`env(safe-area-inset-*)`, que as variáveis `--topo`/`--base` do `index.html` já usam); em WebView mais antiga o próprio Android recua a tela. O recuo entra uma vez só.

**Regra:** o `EdgeToEdge.enable(this)` vem **depois** do `super.onCreate`. Chamado antes, ele cria a janela com a tela ainda no tema da abertura (`AppTheme.NoActionBarLaunch`, cujo fundo é a imagem de abertura), e essa imagem aparece como uma faixa espremida no topo; a `BridgeActivity` só troca o tema dentro do `super.onCreate`. O teste do script confere essa ordem.

O service worker não entra no app: os arquivos já vêm dentro dele.

## Permissões

- **Notificações** (`POST_NOTIFICATIONS`): pedida à pessoa só quando ela liga o lembrete em Ajustes › Lembretes.
- As que o plugin de notificações traz para reagendar os lembretes depois que o celular reinicia (`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`). Não aparecem como pergunta.
- **Internet: não.** `scripts/plugin-android.mjs` tira a permissão que o Capacitor põe por padrão, e o workflow falha se ela aparecer no manifesto final.
- Armazenamento: não. A pasta do backup é liberada pelo seletor de pastas do Android, só ela.
- O widget não pede nenhuma.

O workflow lista no resumo de cada envio as permissões e o identificador do APK que saiu (e falha se o APK de teste não terminar em `.teste`).

## Plugin próprio

`android-plugin/CaixinhasPlugin.java` (ligado pelo `scripts/plugin-android.mjs`):

- **compartilhar:** grava o arquivo na pasta temporária do app e abre o compartilhamento. Quem envia é o app escolhido pela pessoa.
- **pasta do backup:** uma cópia por dia, `caixinhas-backup-AAAA-MM-DD-xxxx.json`, em que `xxxx` é a marca do aparelho. Ficam as 7 mais novas **daquele aparelho**; cópias de outro aparelho nunca são apagadas nem trocadas. A marca vem do `ANDROID_ID`, que desde o Android 8 depende da chave de assinatura e não do pacote: como os APKs de teste (o antigo `com.joah.caixinhas` e o `.teste`) usam a mesma chave, no APK de teste o pacote entra na conta e a marca muda; no app da loja (outra chave) a conta é a de sempre. Numa pasta que já tem cópias, o app mostra quais são e pergunta antes de gravar.

## Lembretes

Plugin oficial `@capacitor/local-notifications`. O app agenda no próprio aparelho uma notificação por dia de vencimento (faturas e gastos fixos dos próximos 60 dias), sem valores no texto, e refaz a agenda quando abre ou quando as contas mudam. A hora é aproximada (o app não pede a permissão de alarme exato).

O ícone da notificação é o símbolo do app em uma cor só (`android-assets/res/drawable/ic_notif.xml`, desenho vetorial branco sobre transparente, sem tamanhos separados), ligado por `LocalNotifications.smallIcon: "ic_notif"`; a cor vem de `iconColor`.

## Widget "Lançar gasto"

`android-plugin/LancarWidget.java`, com layout, fundo, textos e dados em `android-assets/res/` (o `scripts/plugin-android.mjs` copia para `res/` e registra o `<receiver>` no manifesto, como na documentação do Android: `exported="false"`, quem manda as atualizações é o próprio sistema).

- Mostra o botão "+ Lançar gasto" e, embaixo, a sobra do mês e quanto dá por dia. Começa 2x2 e pode encolher até 2x1 (aí sai a linha do "por dia"). Cores do tema padrão.
- A cada salvamento o app chama `Caixinhas.widget({ sobra, mes, ultimoDia, mostrar })` (texto com ponto, "AAAA-MM", número, sim/não), que fica guardado no aparelho e redesenha o widget.
- O widget se redesenha quando o app salva, quando a pessoa muda o tamanho dele e, sem o app aberto, mais ou menos uma vez por dia, contada a partir de quando foi posto na tela (`updatePeriodMillis` de 24 h; sem alarme, sem permissão). Em cada desenho ele refaz o "por dia" (sobra ÷ dias que faltam, contando hoje) com a data do aparelho e compara o mês guardado com o mês atual: se o mês virou, mostra só o botão.
- Por isso, entre dois desenhos o widget mostra o que calculou no último: na virada do mês ele pode seguir com a sobra do mês anterior **por até 24 h**, até o próximo desenho do Android ou até o app ser aberto (que manda os valores do mês novo); o "por dia" pode ficar com o valor da véspera pelo mesmo tempo.
- **Com PIN ligado** o app manda `mostrar: false` e a sobra vazia: nenhum valor fica guardado fora do app e o widget mostra só o botão.
- Tocar abre o app com o endereço `caixinhas://lancar`. O app abre a folha de lançar (com o PIN, só depois do código). O endereço vale uma vez: reabrir o app pelos recentes ou pelo ícone não abre a folha de novo (a `MainActivity` tira o endereço quando o Android recria a tela, e o `index.html` ignora o endereço de abertura num recarregar).

## Ícone e tela de abertura

`node scripts/gerar-icones.mjs` gera as imagens de `android-assets/` a partir de `icon-simbolo.svg`. As peças de `android-assets/res/` (widget e ícone da notificação) são escritas à mão.
