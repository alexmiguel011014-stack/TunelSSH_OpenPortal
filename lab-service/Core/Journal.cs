using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace OpenPortalLab
{
    // Um fato que o serviço registrou (GOALS 19). O serviço não conhece o `hostId` do app: o app
    // acrescenta o PC (hostId e nome) ao entregar o evento ao gerente.
    public sealed class JournalEvent
    {
        public long Seq;
        public long At;
        public string Type;
        public string Account;
        public string Label;
        public string ReservationId;
        public string SourceIp;
        public string EndReason;
        public string Detail;

        public Dictionary<string, object> ToDict()
        {
            var d = new Dictionary<string, object> { { "seq", Seq }, { "at", At }, { "type", Type } };
            if (Account != null) d["account"] = Account;
            if (Label != null) d["label"] = Label;
            if (ReservationId != null) d["reservationId"] = ReservationId;
            if (SourceIp != null) d["sourceIp"] = SourceIp;
            if (EndReason != null) d["endReason"] = EndReason;
            if (Detail != null) d["detail"] = Detail;
            return d;
        }

        public static JournalEvent FromDict(Dictionary<string, object> d)
        {
            if (d == null) return null;
            long? seq = Json.Int(d, "seq");
            long? at = Json.Int(d, "at");
            string type = Json.Str(d, "type");
            if (!seq.HasValue || seq.Value < 1 || !at.HasValue || string.IsNullOrEmpty(type)) return null;
            return new JournalEvent
            {
                Seq = seq.Value,
                At = at.Value,
                Type = type,
                Account = Json.Str(d, "account"),
                Label = Json.Str(d, "label"),
                ReservationId = Json.Str(d, "reservationId"),
                SourceIp = Json.Str(d, "sourceIp"),
                EndReason = Json.Str(d, "endReason"),
                Detail = Json.Str(d, "detail"),
            };
        }
    }

    // Onde o diário fica: dois "arquivos" (o atual e o anterior, depois de uma rotação).
    public interface IJournalStorage
    {
        string[] ReadAll(bool previous);
        void Append(string line);
        long Size();
        // O atual passa a ser o anterior (o anterior antigo some) e o atual recomeça vazio.
        void Rotate();
        void WriteAll(bool previous, IList<string> lines);
    }

    // %ProgramData%\OpenPortal\lab\journal.jsonl (e journal.jsonl.1). A pasta só abre a SYSTEM e a
    // administradores (LabService.EnsureDataDir): o aluno não lê nem altera o diário.
    public sealed class FileJournalStorage : IJournalStorage
    {
        private readonly string path;

        public FileJournalStorage(string path)
        {
            this.path = path;
        }

        private string PathOf(bool previous)
        {
            return previous ? path + ".1" : path;
        }

        public string[] ReadAll(bool previous)
        {
            string file = PathOf(previous);
            if (!File.Exists(file)) return new string[0];
            return File.ReadAllLines(file, Encoding.UTF8);
        }

        public void Append(string line)
        {
            using (var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read))
            {
                // Uma queda no meio de uma gravação deixa uma linha sem quebra: a próxima começa em
                // linha nova (a linha quebrada é ignorada na leitura).
                bool needsBreak = false;
                if (stream.Length > 0)
                {
                    stream.Seek(-1, SeekOrigin.End);
                    needsBreak = stream.ReadByte() != '\n';
                }
                stream.Seek(0, SeekOrigin.End);
                byte[] bytes = new UTF8Encoding(false).GetBytes((needsBreak ? "\n" : "") + line + "\n");
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        public long Size()
        {
            return File.Exists(path) ? new FileInfo(path).Length : 0;
        }

        public void Rotate()
        {
            string previous = PathOf(true);
            if (File.Exists(previous)) File.Delete(previous);
            if (File.Exists(path)) File.Move(path, previous);
        }

        public void WriteAll(bool previous, IList<string> lines)
        {
            string file = PathOf(previous);
            string tmp = file + ".tmp";
            File.WriteAllLines(tmp, lines, new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(tmp, file, null);
            else File.Move(tmp, file);
        }
    }

    // O diário do serviço: só acrescenta, com número de sequência que NUNCA volta atrás (nem depois de um
    // reinício ou de uma rotação), limite de tamanho e retenção. O evento é gravado ANTES de qualquer
    // aviso ao gerente: o gerente que estava fora do ar recupera tudo pelo número de sequência.
    public sealed class Journal
    {
        public const long DefaultMaxBytes = 20L * 1024 * 1024;
        public const int DefaultRetentionDays = 180;
        public const int MaxReadLimit = 500;
        private const int RecentKept = 2000;
        private const long DayMs = 24L * 3600 * 1000;

        private readonly IJournalStorage storage;
        private readonly IClock clock;
        private readonly ILog log;
        private readonly long maxBytes;
        private readonly object gate = new object();
        // Os últimos eventos, em memória: a consulta de rotina (o app pergunta a cada poucos segundos)
        // não reabre os arquivos.
        private readonly List<JournalEvent> recent = new List<JournalEvent>();
        private long lastSeq;
        private long firstSeq;

        public Journal(IJournalStorage storage, IClock clock, ILog log, long maxBytes = DefaultMaxBytes)
        {
            this.storage = storage;
            this.clock = clock;
            this.log = log;
            this.maxBytes = maxBytes;
            Load();
        }

        public long LastSeq
        {
            get { lock (gate) { return lastSeq; } }
        }

        private IEnumerable<JournalEvent> Parse(string[] lines)
        {
            foreach (string line in lines)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                JournalEvent e = null;
                try { e = JournalEvent.FromDict(Json.ParseObject(line)); } catch { }
                // Linha quebrada (uma queda no meio da gravação) ou de outro formato: ignorada.
                if (e != null) yield return e;
            }
        }

        private static List<KeyValuePair<string, JournalEvent>> ParseLines(string[] lines)
        {
            var result = new List<KeyValuePair<string, JournalEvent>>();
            foreach (string line in lines)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                JournalEvent e = null;
                try { e = JournalEvent.FromDict(Json.ParseObject(line)); } catch { }
                if (e != null) result.Add(new KeyValuePair<string, JournalEvent>(line, e));
            }
            return result;
        }

        private void Load()
        {
            lock (gate)
            {
                recent.Clear();
                lastSeq = 0;
                firstSeq = 0;
                foreach (bool previous in new[] { true, false })
                {
                    foreach (JournalEvent e in Parse(storage.ReadAll(previous)))
                    {
                        if (firstSeq == 0 || e.Seq < firstSeq) firstSeq = e.Seq;
                        if (e.Seq > lastSeq) lastSeq = e.Seq;
                        recent.Add(e);
                        if (recent.Count > RecentKept) recent.RemoveAt(0);
                    }
                }
            }
        }

        // Grava e devolve o evento já com o número de sequência.
        public JournalEvent Append(string type, string account, string label, string reservationId, string sourceIp, string endReason, string detail)
        {
            lock (gate)
            {
                if (storage.Size() >= maxBytes)
                {
                    storage.Rotate();
                    // O arquivo anterior de antes da rotação sumiu: o evento mais antigo que resta é o
                    // primeiro do novo anterior.
                    firstSeq = 0;
                    foreach (JournalEvent old in Parse(storage.ReadAll(true)))
                    {
                        if (firstSeq == 0 || old.Seq < firstSeq) firstSeq = old.Seq;
                    }
                    // E a memória não guarda o que o arquivo já não tem.
                    recent.RemoveAll(item => item.Seq < firstSeq);
                    log.Info("diário rotacionado");
                }
                var e = new JournalEvent
                {
                    Seq = lastSeq + 1,
                    At = clock.NowMs,
                    Type = type,
                    Account = account,
                    Label = label,
                    ReservationId = reservationId,
                    SourceIp = sourceIp,
                    EndReason = endReason,
                    Detail = detail,
                };
                storage.Append(Json.Write(e.ToDict()));
                lastSeq = e.Seq;
                if (firstSeq == 0) firstSeq = e.Seq;
                recent.Add(e);
                if (recent.Count > RecentKept) recent.RemoveAt(0);
                return e;
            }
        }

        // Eventos com seq > sinceSeq, do mais antigo ao mais novo (no máximo `limit`). `firstSeq` é o
        // mais antigo que ainda existe: se for maior que sinceSeq + 1, o gerente perdeu uma parte (a
        // rotação ou a retenção apagou) e registra a lacuna.
        public Dictionary<string, object> Read(long sinceSeq, int limit)
        {
            if (limit < 1) limit = 1;
            if (limit > MaxReadLimit) limit = MaxReadLimit;
            lock (gate)
            {
                IEnumerable<JournalEvent> source;
                if (recent.Count > 0 && sinceSeq >= recent[0].Seq - 1)
                {
                    source = recent;
                }
                else
                {
                    // Pedido antigo: lê os arquivos.
                    var all = new List<JournalEvent>();
                    foreach (bool previous in new[] { true, false }) all.AddRange(Parse(storage.ReadAll(previous)));
                    source = all;
                }
                var events = new List<object>();
                foreach (JournalEvent e in source)
                {
                    if (e.Seq <= sinceSeq) continue;
                    events.Add(e.ToDict());
                    if (events.Count >= limit) break;
                }
                return new Dictionary<string, object>
                {
                    { "events", events },
                    { "lastSeq", lastSeq },
                    { "firstSeq", firstSeq },
                };
            }
        }

        // Retenção: apaga o que é mais velho que `retentionDays`. Nunca deixa o diário vazio (o último
        // evento fica), para o número de sequência não recomeçar depois de um reinício.
        public int Prune(int retentionDays)
        {
            if (retentionDays < 1) return 0;
            long cutoff = clock.NowMs - retentionDays * DayMs;
            lock (gate)
            {
                string[] previousLines = storage.ReadAll(true);
                string[] currentLines = storage.ReadAll(false);
                List<KeyValuePair<string, JournalEvent>> previous = ParseLines(previousLines);
                List<KeyValuePair<string, JournalEvent>> current = ParseLines(currentLines);
                List<KeyValuePair<string, JournalEvent>> keptPrevious = previous.Where(p => p.Value.At >= cutoff).ToList();
                List<KeyValuePair<string, JournalEvent>> keptCurrent = current.Where(p => p.Value.At >= cutoff).ToList();
                if (keptPrevious.Count + keptCurrent.Count == 0)
                {
                    // Nunca esvazia o diário: o último evento fica, ou o número de sequência recomeçaria
                    // depois de um reinício.
                    List<KeyValuePair<string, JournalEvent>> all = previous.Concat(current).ToList();
                    if (all.Count > 0) keptCurrent = new List<KeyValuePair<string, JournalEvent>> { all.OrderBy(p => p.Value.Seq).Last() };
                }
                int removed = previous.Count + current.Count - keptPrevious.Count - keptCurrent.Count;
                bool brokenLines = previous.Count != previousLines.Count(l => !string.IsNullOrWhiteSpace(l))
                    || current.Count != currentLines.Count(l => !string.IsNullOrWhiteSpace(l));
                if (removed > 0 || brokenLines)
                {
                    if (previousLines.Length > 0 || keptPrevious.Count > 0) storage.WriteAll(true, keptPrevious.Select(p => p.Key).ToList());
                    if (currentLines.Length > 0 || keptCurrent.Count > 0) storage.WriteAll(false, keptCurrent.Select(p => p.Key).ToList());
                    Load();
                    log.Info("diário: " + removed + " evento(s) antigos removidos");
                }
                return removed;
            }
        }
    }
}
