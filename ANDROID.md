# Orolon Caixinhas no Android

O app Android é o mesmo site (`index.html`), empacotado com o [Capacitor](https://capacitorjs.com). Tudo é montado no GitHub Actions; nada precisa ser instalado no PC.

## APK de teste (automático)

Cada envio, de qualquer branch, gera um APK de teste publicado em **Releases → Android (teste)**. A página diz de qual branch ele veio.
Ele é assinado com a chave fixa de `android-teste/`, então cada versão nova instala por cima da anterior.

Identificador do app: `com.joah.caixinhas` (não muda depois de publicado na Google Play).

**APK de teste ao lado do app da loja (desde a 2.0):** o APK de teste tem o identificador `com.joah.caixinhas.teste` e se chama "Orolon Caixinhas (teste)", então os dois ficam instalados juntos, cada um com os seus dados, a sua pasta de backup e o seu widget. Mesmo apontando para a mesma pasta, o APK de teste tem marca própria nos backups (ver "Plugin próprio"), então um não apaga as cópias do outro. Quem decide é `scripts/plugin-android.mjs`: sem `CX_LOJA=1` ele põe `applicationIdSuffix ".teste"` no `build.gradle` e o "(teste)" no nome; com `CX_LOJA=1` (pacote da loja) não mexe em nada disso. O que depende do identificador acompanha sozinho (o FileProvider usa `${applicationId}` no manifesto e `getPackageName()` no plugin).
Os dados de um APK de teste anterior à 2.0 (`com.joah.caixinhas`) **não passam sozinhos** para o novo: exporte um backup no antigo e importe no novo.

As versões das bibliotecas ficam presas no `package-lock.json` (o workflow usa `npm ci`). Para atualizar o Capacitor: `npm install` no PC e commitar o `package-lock.json` novo.

O arquivo da loja (`.aab`) e a chave de envio ainda não existem; entram quando o app for para a Play.

## O que muda dentro do app

O `index.html` percebe que está no app (`window.Capacitor`) e só então:

- bloqueia o zoom de pinça e respeita a barra de status e a de navegação;
- faz o botão voltar fechar uma coisa por vez (folha de lançar, parte dos Ajustes, aba) e sair do app no Início;
- troca "baixar arquivo" pelo compartilhamento do Android (backup, planilha, tema);
- grava o backup automático numa pasta escolhida no seletor do Android;
- oferece lembretes de contas a vencer por notificação;
- manda a sobra do mês ao widget "Lançar gasto" a cada salvamento e abre a folha de lançar quando o app vem pelo toque nele;
- esconde o apoio pelo GitHub (links "Apoie o projeto" e a tela Apoie), que continua só no site.

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

## Pendências

- Barras do sistema: o conserto do Orolon Player (`SystemBars.insetsHandling: "native"` + `EdgeToEdge.enable(this)`) mostrou um defeito visual num celular de verdade em 19/11/2026 (faixa no topo e cabeçalho espremido) e **não** está aplicado aqui; o Caixinhas segue com o jeito da 1.9 (`"css"`, conferido no celular). Trazer o conserto final só depois de provado no Player.
