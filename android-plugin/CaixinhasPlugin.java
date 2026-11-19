package PACOTE;

// Plugin "Caixinhas": o que o app Android precisa e o navegador não oferece.
// - compartilhar: grava um arquivo (backup, planilha, tema) na pasta temporária do app e abre o compartilhamento do Android;
// - pasta do backup: a pessoa escolhe uma pasta no seletor do Android, que libera só aquela pasta (sem permissão de armazenamento);
// - widget: guarda o que o widget "Lançar gasto" mostra (ver LancarWidget.java) e pede que ele se redesenhe.
// Nada aqui usa a internet nem pede permissão.
// O script scripts/plugin-android.mjs copia este arquivo para o projeto Android e troca PACOTE pelo pacote do app.

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;

@CapacitorPlugin(name = "Caixinhas")
public class CaixinhasPlugin extends Plugin {

    // Marca deste aparelho (4 letras/números), tirada do identificador que o Android dá ao app neste aparelho.
    // Ela não vem junto quando o Android restaura os dados num celular novo; por isso cada aparelho tem a sua.
    // APK de teste (identificador terminado em ".teste"): desde o Android 8 o ANDROID_ID depende da chave de assinatura,
    // não do pacote, e o APK de teste antigo (com.joah.caixinhas) e o novo (.teste) usam a mesma chave de android-teste/.
    // Sem diferença, os dois teriam a mesma marca e, na mesma pasta, um apagaria as cópias do outro. Por isso o pacote
    // entra na conta só no APK de teste; o app da loja (com.joah.caixinhas, outra chave) fica com a marca de sempre.
    @PluginMethod
    public void aparelho(PluginCall call) {
        JSObject r = new JSObject();
        try {
            String id = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
            String pacote = getContext().getPackageName();
            if (id != null && !id.isEmpty() && pacote != null && pacote.endsWith(".teste")) id = id + ":" + pacote;
            if (id != null && !id.isEmpty()) {
                final String letras = "abcdefghijkmnpqrstuvwxyz23456789";
                int h = id.hashCode();
                StringBuilder m = new StringBuilder();
                for (int i = 0; i < 4; i++) { m.append(letras.charAt(h & 31)); h >>>= 5; }
                r.put("marca", m.toString());
            }
        } catch (Exception e) { /* sem identificador: o app usa uma marca sorteada */ }
        call.resolve(r);
    }

    // O app manda, a cada salvamento: sobra do mês (texto com ponto, vazio com PIN), mês "AAAA-MM", último dia do mês
    // e se o widget pode mostrar valores. Com PIN ligado, nenhum valor fica guardado aqui.
    @PluginMethod
    public void widget(PluginCall call) {
        final boolean mostrar = Boolean.TRUE.equals(call.getBoolean("mostrar", false));
        final String sobra = mostrar ? call.getString("sobra", "") : "";
        final String mes = call.getString("mes", "");
        final Integer ultimoDia = call.getInt("ultimoDia", 0);
        getContext().getSharedPreferences(LancarWidget.PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("mostrar", mostrar)
            .putString("sobra", sobra == null ? "" : sobra)
            .putString("mes", mes == null ? "" : mes)
            .putInt("ultimoDia", ultimoDia == null ? 0 : ultimoDia)
            .apply();
        try { LancarWidget.atualizarTodos(getContext()); } catch (Exception e) { /* sem widget na tela: nada a redesenhar */ }
        call.resolve();
    }

    @PluginMethod
    public void compartilhar(PluginCall call) {
        final String nome = call.getString("nome", "caixinhas-backup.json");
        final String texto = call.getString("texto");
        final String titulo = call.getString("titulo", nome);
        final String tipoPedido = call.getString("tipo", "application/json");
        final int pv = tipoPedido.indexOf(';');
        final String tipo = (pv >= 0 ? tipoPedido.substring(0, pv) : tipoPedido).trim(); // "text/csv;charset=utf-8" esconderia apps que aceitam text/csv
        if (texto == null) { call.reject("sem-texto"); return; }
        new Thread(() -> {
            try {
                File pasta = new File(getContext().getCacheDir(), "enviar");
                if (!pasta.exists() && !pasta.mkdirs()) { call.reject("sem-pasta-temporaria"); return; }
                File[] velhos = pasta.listFiles();
                if (velhos != null) for (File v : velhos) v.delete();
                File f = new File(pasta, nome.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_"));
                try (FileOutputStream o = new FileOutputStream(f)) { o.write(texto.getBytes(StandardCharsets.UTF_8)); }
                Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType(tipo);
                i.putExtra(Intent.EXTRA_STREAM, u);
                i.putExtra(Intent.EXTRA_SUBJECT, nome);
                i.setClipData(ClipData.newRawUri(nome, u));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent escolha = Intent.createChooser(i, titulo);
                escolha.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(escolha);
                call.resolve();
            } catch (Exception e) {
                call.reject("falha-ao-compartilhar: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void escolherPastaBackup(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "depoisDaPastaBackup");
    }

    @ActivityCallback
    private void depoisDaPastaBackup(PluginCall call, ActivityResult res) {
        JSObject r = new JSObject();
        Intent d = res.getData();
        if (res.getResultCode() != Activity.RESULT_OK || d == null || d.getData() == null) { r.put("cancelado", true); call.resolve(r); return; }
        Uri arvore = d.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(arvore, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) { /* sem permissão permanente: a gravação vai avisar */ }
        String id = DocumentsContract.getTreeDocumentId(arvore);
        int k = id.indexOf(':');
        r.put("uri", arvore.toString());
        r.put("nome", k >= 0 && k < id.length() - 1 ? id.substring(k + 1) : id);
        call.resolve(r);
    }

    private static boolean ehBackup(String nome) { return nome != null && nome.startsWith("caixinhas-backup-") && nome.endsWith(".json"); }

    // Cada backup da pasta vira { id do documento, nome, modificado }
    private ArrayList<String[]> backupsDa(Uri arvore) {
        ArrayList<String[]> r = new ArrayList<>();
        Uri filhos = DocumentsContract.buildChildDocumentsUriUsingTree(arvore, DocumentsContract.getTreeDocumentId(arvore));
        String[] campos = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
        try (Cursor c = getContext().getContentResolver().query(filhos, campos, null, null, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    String nome = c.isNull(1) ? null : c.getString(1);
                    if (ehBackup(nome)) r.add(new String[] { c.getString(0), nome, c.isNull(2) ? "0" : String.valueOf(c.getLong(2)) });
                }
            }
        }
        return r;
    }

    private void apagarDocumento(Uri arvore, String id) {
        try { DocumentsContract.deleteDocument(getContext().getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(arvore, id)); } catch (Exception e) { /* já apagado */ }
    }

    @PluginMethod
    public void gravarBackup(PluginCall call) {
        final String uriTxt = call.getString("uri");
        final String nome = call.getString("nome");
        final String texto = call.getString("texto");
        final int manter = Math.max(1, call.getInt("manter", 7));
        final String grupo = call.getString("grupo"); // final do nome das cópias deste aparelho: só elas entram na limpeza
        if (uriTxt == null || texto == null || !ehBackup(nome)) { call.reject("dados-invalidos"); return; }
        new Thread(() -> {
            try {
                Uri arvore = Uri.parse(uriTxt);
                ContentResolver cr = getContext().getContentResolver();
                Uri pasta = DocumentsContract.buildDocumentUriUsingTree(arvore, DocumentsContract.getTreeDocumentId(arvore));
                Uri novo = null; // a cópia de hoje é regravada no lugar: se a gravação falhar, a anterior não some antes
                for (String[] b : backupsDa(arvore)) if (nome.equals(b[1])) { novo = DocumentsContract.buildDocumentUriUsingTree(arvore, b[0]); break; }
                if (novo == null) novo = DocumentsContract.createDocument(cr, pasta, "application/json", nome);
                if (novo == null) { call.reject("sem-acesso"); return; }
                try (OutputStream o = cr.openOutputStream(novo, "wt")) {
                    if (o == null) { call.reject("sem-acesso"); return; }
                    o.write(texto.getBytes(StandardCharsets.UTF_8));
                }
                ArrayList<String[]> todos = new ArrayList<>();
                for (String[] b : backupsDa(arvore)) if (grupo != null && b[1].endsWith(grupo)) todos.add(b); // nunca apaga cópia de outro aparelho
                Collections.sort(todos, (x, y) -> y[1].compareTo(x[1])); // o nome traz a data: o mais novo vem primeiro
                for (int n = manter; n < todos.size(); n++) apagarDocumento(arvore, todos.get(n)[0]);
                call.resolve();
            } catch (Exception e) {
                call.reject("falha-no-backup: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void listarBackups(PluginCall call) {
        final String uriTxt = call.getString("uri");
        if (uriTxt == null) { call.reject("sem-uri"); return; }
        new Thread(() -> {
            try {
                Uri arvore = Uri.parse(uriTxt);
                JSArray lista = new JSArray();
                for (String[] b : backupsDa(arvore)) {
                    JSObject m = new JSObject();
                    m.put("doc", DocumentsContract.buildDocumentUriUsingTree(arvore, b[0]).toString());
                    m.put("nome", b[1]);
                    m.put("modificado", Long.parseLong(b[2]));
                    lista.put(m);
                }
                JSObject r = new JSObject();
                r.put("backups", lista);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("falha-na-pasta: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void lerBackup(PluginCall call) {
        final String doc = call.getString("doc");
        if (doc == null) { call.reject("sem-doc"); return; }
        new Thread(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(doc))) {
                if (in == null) { call.reject("sem-acesso"); return; }
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                JSObject r = new JSObject();
                r.put("texto", new String(o.toByteArray(), StandardCharsets.UTF_8));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("falha-ao-ler: " + e.getMessage());
            }
        }).start();
    }
}
