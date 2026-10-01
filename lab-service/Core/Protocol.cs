using System;
using System.Collections.Generic;
using System.Text;

namespace OpenPortalLab
{
    // Quem pode falar com o pipe: SYSTEM e a conta que roda o app (o dono). Cada
    // pedido é conferido contra o SID de quem chamou, além da ACL do próprio pipe.
    public static class PipeAuth
    {
        public const string SystemSid = "S-1-5-18";

        public static bool IsAllowed(string callerSid, string ownerSid)
        {
            if (string.IsNullOrEmpty(callerSid)) return false;
            if (string.Equals(callerSid, SystemSid, StringComparison.OrdinalIgnoreCase)) return true;
            return !string.IsNullOrEmpty(ownerSid) && string.Equals(callerSid, ownerSid, StringComparison.OrdinalIgnoreCase);
        }
    }

    // O pipe local \\.\pipe\OpenPortalLab: uma linha JSON por pedido e por
    // resposta. Os comandos são fixos e cada campo é validado aqui; o texto do
    // pedido nunca vira nome de conta, caminho ou argumento de comando sem passar
    // por uma regra (Names.IsValidAccount, intervalos numéricos, lista de motivos).
    public static class Protocol
    {
        public const int MaxRequestBytes = 4 * 1024;
        public const int MaxResponseBytes = 256 * 1024;

        public static readonly string[] Commands =
        {
            "status", "disk-info", "student-create", "student-delete", "student-set-quota",
            "reserve", "extend", "end", "ensure-folder-access", "events",
        };

        // Recebe uma linha de pedido e devolve a linha de resposta. Nunca lança.
        public static string Handle(Engine engine, string line)
        {
            string id = null;
            try
            {
                if (line == null || Encoding.UTF8.GetByteCount(line) > MaxRequestBytes)
                {
                    return Respond(null, Result.Fail("bad-request", "Pedido grande demais"));
                }
                Dictionary<string, object> request = Json.ParseObject(line);
                if (request == null) return Respond(null, Result.Fail("bad-request", "JSON inválido"));
                id = Json.Str(request, "id");
                if (id != null && id.Length > 64) id = id.Substring(0, 64);

                string cmd = Json.Str(request, "cmd");
                if (cmd == null || Array.IndexOf(Commands, cmd) < 0)
                {
                    return Respond(id, Result.Fail("unsupported", "Comando desconhecido"));
                }
                return Respond(id, Dispatch(engine, cmd, request));
            }
            catch (Exception)
            {
                // Sem detalhes na resposta: o motivo vai para o registro do serviço.
                return Respond(id, Result.Fail("internal", "Falha ao atender o pedido"));
            }
        }

        private static Result Dispatch(Engine engine, string cmd, Dictionary<string, object> request)
        {
            switch (cmd)
            {
                case "status":
                    return engine.Status();

                case "disk-info":
                {
                    double? reserve = Num(request, "reserveGb");
                    double? quota = Num(request, "quotaGb");
                    if (reserve.HasValue && (reserve.Value < 0 || reserve.Value > 100000)) return Bad("reserveGb");
                    if (quota.HasValue && (quota.Value < 1 || quota.Value > 2000)) return Bad("quotaGb");
                    return engine.DiskInfoResult(reserve, quota);
                }

                case "student-create":
                {
                    string label = Json.Str(request, "label");
                    long? quota = Json.Int(request, "quotaGb");
                    if (label == null) return Bad("label");
                    if (!quota.HasValue) return Bad("quotaGb");
                    return engine.StudentCreate(label, quota.Value);
                }

                case "student-set-quota":
                {
                    string account = Account(request);
                    long? quota = Json.Int(request, "quotaGb");
                    if (account == null) return Bad("account");
                    if (!quota.HasValue) return Bad("quotaGb");
                    return engine.StudentSetQuota(account, quota.Value);
                }

                case "student-delete":
                {
                    string account = Account(request);
                    return account == null ? Bad("account") : engine.StudentDelete(account);
                }

                case "ensure-folder-access":
                {
                    string account = Account(request);
                    return account == null ? Bad("account") : engine.EnsureFolderAccess(account);
                }

                case "reserve":
                {
                    string account = Account(request);
                    long? startWithin = Json.Int(request, "startWithinMs");
                    long? session = Json.Int(request, "sessionMs");
                    if (account == null) return Bad("account");
                    if (!startWithin.HasValue) return Bad("startWithinMs");
                    if (!session.HasValue) return Bad("sessionMs");
                    return engine.Reserve(account, startWithin.Value, session.Value);
                }

                case "extend":
                {
                    string reservationId = ReservationId(request);
                    long? add = Json.Int(request, "addMs");
                    if (reservationId == null) return Bad("reservationId");
                    if (!add.HasValue) return Bad("addMs");
                    return engine.Extend(reservationId, add.Value);
                }

                case "end":
                {
                    string reservationId = ReservationId(request);
                    string reason = Json.Str(request, "reason");
                    if (reservationId == null) return Bad("reservationId");
                    if (reason == null) return Bad("reason");
                    return engine.End(reservationId, reason);
                }

                default:
                    // `events` chega com o GOALS 19 (diário do serviço).
                    return Result.Fail("unsupported", "Comando ainda não disponível");
            }
        }

        private static Result Bad(string field)
        {
            return Result.Fail("bad-request", "Campo inválido: " + field);
        }

        private static string Account(Dictionary<string, object> request)
        {
            string account = Json.Str(request, "account");
            return Names.IsValidAccount(account) ? account : null;
        }

        private static string ReservationId(Dictionary<string, object> request)
        {
            string id = Json.Str(request, "reservationId");
            if (id == null || id.Length < 8 || id.Length > 64) return null;
            foreach (char c in id)
            {
                bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
                if (!ok) return null;
            }
            return id;
        }

        private static double? Num(Dictionary<string, object> request, string key)
        {
            object value;
            if (!request.TryGetValue(key, out value) || value == null) return null;
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            if (value is decimal) return (double)(decimal)value;
            if (value is double) return (double)value;
            return null;
        }

        // Monta a linha de resposta, respeitando o limite de 256 KiB.
        public static string Respond(string id, Result result)
        {
            var body = new Dictionary<string, object>();
            if (id != null) body["id"] = id;
            body["ok"] = result.Ok;
            if (result.Ok)
            {
                foreach (KeyValuePair<string, object> pair in result.Data) body[pair.Key] = pair.Value;
            }
            else
            {
                body["error"] = result.Error;
                if (!string.IsNullOrEmpty(result.Message)) body["message"] = result.Message;
                foreach (KeyValuePair<string, object> pair in result.Data)
                {
                    if (!body.ContainsKey(pair.Key)) body[pair.Key] = pair.Value;
                }
            }
            string text = Json.Write(body);
            if (Encoding.UTF8.GetByteCount(text) > MaxResponseBytes)
            {
                var small = new Dictionary<string, object>();
                if (id != null) small["id"] = id;
                small["ok"] = false;
                small["error"] = "internal";
                small["message"] = "Resposta grande demais";
                text = Json.Write(small);
            }
            return text;
        }
    }
}
