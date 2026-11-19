package PACOTE;

// Widget "Lançar gasto": o botão "+ Lançar gasto" e, embaixo, a sobra do mês e quanto dá por dia.
// - O app manda os valores pelo plugin (CaixinhasPlugin.widget) sempre que salva: sobra, mês ("AAAA-MM"), último dia do mês
//   e se pode mostrar valores (com PIN ligado, não: o widget fica só com o botão).
// - O "por dia" é refeito aqui a cada atualização (sobra ÷ dias que faltam, contando hoje), para não envelhecer com o app fechado;
//   o Android pede uma atualização por dia (updatePeriodMillis no res/xml/widget_lancar.xml). Mês virado: só o botão.
// - Tocar abre o app com o endereço caixinhas://lancar, e o app abre a folha de lançar (depois do PIN, se houver).
// Nada aqui usa a internet nem pede permissão.
// O script scripts/plugin-android.mjs copia este arquivo para o projeto Android e troca PACOTE pelo pacote do app.

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import java.util.Calendar;

public class LancarWidget extends AppWidgetProvider {

    // onde o plugin guarda o que o app mandou (só neste aparelho; fora do backup do app)
    static final String PREFS = "caixinhas_widget";
    static final String ENDERECO = "caixinhas://lancar";

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, montar(context, mgr, id));
    }

    // a pessoa mudou o tamanho do widget: num espaço baixo (2x1) sai a linha do "por dia"
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager mgr, int id, Bundle opcoes) {
        mgr.updateAppWidget(id, montar(context, mgr, id));
    }

    // chamado pelo plugin depois de gravar os valores novos
    static void atualizarTodos(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        if (mgr == null) return;
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, LancarWidget.class));
        if (ids == null) return;
        for (int id : ids) mgr.updateAppWidget(id, montar(context, mgr, id));
    }

    static RemoteViews montar(Context context, AppWidgetManager mgr, int id) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_lancar);

        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean mostrar = p.getBoolean("mostrar", false);
        String sobraTxt = p.getString("sobra", "");
        String mes = p.getString("mes", "");
        int ultimoDia = p.getInt("ultimoDia", 0);

        Calendar hoje = Calendar.getInstance();
        int ano = hoje.get(Calendar.YEAR), mesHoje = hoje.get(Calendar.MONTH) + 1, dia = hoje.get(Calendar.DAY_OF_MONTH);
        String chaveHoje = ano + "-" + (mesHoje < 10 ? "0" : "") + mesHoje;
        if (ultimoDia < dia || ultimoDia > 31) ultimoDia = hoje.getActualMaximum(Calendar.DAY_OF_MONTH);
        int faltam = ultimoDia - dia + 1; // contando hoje

        double sobra = Double.NaN;
        if (sobraTxt != null && sobraTxt.length() > 0) {
            try { sobra = Double.parseDouble(sobraTxt); } catch (NumberFormatException e) { sobra = Double.NaN; }
        }

        // com PIN, sem valores ainda ou com o mês já virado: só o botão
        if (mostrar && chaveHoje.equals(mes) && !Double.isNaN(sobra) && !Double.isInfinite(sobra)) {
            v.setViewVisibility(R.id.widget_valores, View.VISIBLE);
            v.setTextViewText(R.id.widget_sobra, dinheiro(sobra));
            String linha;
            if (sobra > 0) linha = dinheiro(sobra / faltam) + " por dia";
            else if (sobra < 0) linha = "passou do limite";
            else linha = "nada sobrando";
            v.setTextViewText(R.id.widget_dia, linha);
            v.setViewVisibility(R.id.widget_dia, baixo(mgr, id) ? View.GONE : View.VISIBLE);
        } else {
            v.setViewVisibility(R.id.widget_valores, View.GONE);
        }

        // abre a tela do app com o endereço do widget; o app (AppPlugin) recebe pelo appUrlOpen ou pelo getLaunchUrl
        Intent abrir = new Intent(context, MainActivity.class);
        abrir.setAction(Intent.ACTION_VIEW);
        abrir.setData(Uri.parse(ENDERECO));
        abrir.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent toque = PendingIntent.getActivity(context, 0, abrir, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        v.setOnClickPendingIntent(R.id.widget_raiz, toque);
        v.setOnClickPendingIntent(R.id.widget_botao, toque);
        return v;
    }

    // widget de uma linha só de altura (2x1): pouco espaço para três linhas
    private static boolean baixo(AppWidgetManager mgr, int id) {
        try {
            Bundle o = mgr.getAppWidgetOptions(id);
            int altura = o == null ? 0 : o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            return altura > 0 && altura < 100;
        } catch (Exception e) {
            return false;
        }
    }

    // R$ 1.234,56 no jeito brasileiro, sem depender do idioma do aparelho
    static String dinheiro(double valor) {
        long centavos = Math.round(Math.abs(valor) * 100);
        String reais = Long.toString(centavos / 100);
        int cent = (int) (centavos % 100);
        StringBuilder b = new StringBuilder();
        int n = reais.length();
        for (int i = 0; i < n; i++) {
            if (i > 0 && (n - i) % 3 == 0) b.append('.');
            b.append(reais.charAt(i));
        }
        return (valor < 0 && centavos > 0 ? "-R$ " : "R$ ") + b + "," + (cent < 10 ? "0" : "") + cent;
    }
}
