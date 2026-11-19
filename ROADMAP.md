# Planos do Orolon Caixinhas

O que vem depois da 2.0. O núcleo continua grátis, offline, sem conta e sem anúncios: nenhuma função do app é ou será paga.

## Onde o app está (19/11/2026)

A **2.0 "Noite Orologia"** reúne o visual novo, a tela de Gráficos, o uso no computador, 14 temas e o widget do Android (veja o [histórico](CHANGELOG.md)). Com ela, o que falta para lançar não é função, é publicação.

## Próximos passos

1. **Google Play, teste fechado.** O app ainda não foi criado no Play Console. Conta pessoal nova: 12 testadores inscritos por 14 dias seguidos antes de pedir a produção (foi a regra no Orolon Player; **a confirmar** na Central de Ajuda do Play Console). A ficha, as respostas do Console e as imagens estão em [`loja/`](loja/); o `.aab` sai pelo workflow "App Android (loja)" (veja [ANDROID.md](ANDROID.md)). Vale começar a juntar testadores cedo, inclusive em comunidades de desenvolvedores.
2. **Barras do sistema no Android.** Aplicado na 2.0 do mesmo jeito que no Orolon Player 1.26.6 (o app desenha de ponta a ponta, para não sobrar faixa vazia em cima e embaixo). **A confirmar** nos celulares: o do Jo-ah e o Galaxy S20 FE de um testador.
3. **O que só o celular prova:** a notificação chegando na hora, a planilha exportada abrindo, restaurar um backup da pasta, o widget no tamanho 2x1 e se o visual pesa ou esquenta em celulares mais simples.
4. **Pequenos acertos adiados:**
   - ao trocar a pasta do backup no Android, devolver a permissão da pasta antiga;
   - conferir, com dois aparelhos na mesma pasta, que cada um só apaga as próprias cópias (só dá para provar no app instalado);
   - Esc fora do Início usa `history.back()`: numa aba aberta direto em `#mes` vinda de outra página, o Esc sai do app;
   - `color-mix()` não tem cor de reserva: em WebView abaixo da 111 os cartões ficam sem fundo (o texto continua legível). Só a folha de lançar e o aviso curto já têm reserva (um `@supports not` com fundo simples); o resto não;
   - vários testes de movimento dependem de esperas fixas (podem falhar num computador lento);
   - a marca `.teste` do APK de teste e a limpeza das cópias por aparelho são feitas no Java: só o aparelho prova.

## Ideias

- **Setas de mês no Início.** Hoje o Início mostra sempre o mês atual (o Mês e os Gráficos navegam entre meses). Se fizer falta, acrescentar.
- **Mais tamanhos de widget**, como um que mostra as caixinhas.
- Ideias que surgirem no teste fechado entram aqui.

## Apoiador (só planejamento)

Nada disto existe no app, e nada aparece nele até existir de verdade. É o registro do que foi combinado para um dia:

- **Compra única e vitalícia**, sem assinatura. Quem não comprar continua com o app inteiro.
- **Só cosméticos:** temas extras, pacotes de ícones para as caixinhas, ícones alternativos para o app e estilos de widget.
- **Nunca função.** Nenhuma conta, gráfico, calculadora, backup ou lembrete fica atrás da compra.
- **Nunca tirar o que já é livre.** Os 14 temas da 2.0 e tudo o que existe hoje continuam livres.
- O mesmo modelo do Orolon Player, para os dois apps andarem juntos.
- Como vender (pela Google Play ou liberando para quem apoia pelo GitHub Sponsors) ainda está em aberto. Vender pela Play numa conta pessoal pode deixar o endereço do desenvolvedor público na loja: **a confirmar** nas regras de perfil de pagamentos do Play Console.

## O que não fazer

- Anúncios, assinatura ou conta.
- Ligar o app ao banco ou a qualquer servidor: os dados ficam no aparelho.
- Pedir número, validade ou código de cartão.
- Travar função atrás de pagamento.
