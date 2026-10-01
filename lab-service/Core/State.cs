using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace OpenPortalLab
{
    public sealed class Student
    {
        public string Account;
        public string Label;
        public int QuotaGb;
        public long CreatedAt;
        public long LastSessionEnd;

        public Dictionary<string, object> ToDict()
        {
            return new Dictionary<string, object>
            {
                { "account", Account },
                { "label", Label },
                { "quotaGb", QuotaGb },
                { "createdAt", CreatedAt },
                { "lastSessionEnd", LastSessionEnd },
            };
        }

        public static Student FromDict(Dictionary<string, object> d)
        {
            string account = Json.Str(d, "account");
            string label = Names.CleanLabel(Json.Str(d, "label"));
            long? quota = Json.Int(d, "quotaGb");
            if (!Names.IsValidAccount(account) || label == null || !quota.HasValue) return null;
            return new Student
            {
                Account = account,
                Label = label,
                QuotaGb = (int)Math.Max(1, Math.Min(2000, quota.Value)),
                CreatedAt = Json.Int(d, "createdAt") ?? 0,
                LastSessionEnd = Json.Int(d, "lastSessionEnd") ?? 0,
            };
        }
    }

    public static class ReservationStates
    {
        public const string Reserved = "reserved";
        public const string InUse = "in-use";
        public const string Ending = "ending";
    }

    // A senha nunca entra aqui: só existe na resposta do `reserve`.
    public sealed class Reservation
    {
        public string Id;
        public string Account;
        public string State;
        public long CreatedAt;
        public long StartBy;
        public long SessionMs;
        // Até a primeira entrada, é o último instante possível (StartBy + SessionMs);
        // depois dela, primeira entrada + SessionMs (mais as extensões).
        public long EndsAt;
        public long FirstLogonAt;
        public long LastSeenAt;
        public bool Warned;
        public string EndReason;

        public Dictionary<string, object> ToDict()
        {
            return new Dictionary<string, object>
            {
                { "id", Id },
                { "account", Account },
                { "state", State },
                { "createdAt", CreatedAt },
                { "startBy", StartBy },
                { "sessionMs", SessionMs },
                { "endsAt", EndsAt },
                { "firstLogonAt", FirstLogonAt },
                { "lastSeenAt", LastSeenAt },
                { "warned", Warned },
                { "endReason", EndReason },
            };
        }

        public static Reservation FromDict(Dictionary<string, object> d)
        {
            if (d == null) return null;
            string id = Json.Str(d, "id");
            string account = Json.Str(d, "account");
            string state = Json.Str(d, "state");
            if (string.IsNullOrEmpty(id) || !Names.IsValidAccount(account)) return null;
            if (state != ReservationStates.Reserved && state != ReservationStates.InUse && state != ReservationStates.Ending) return null;
            object warned;
            d.TryGetValue("warned", out warned);
            return new Reservation
            {
                Id = id,
                Account = account,
                State = state,
                CreatedAt = Json.Int(d, "createdAt") ?? 0,
                StartBy = Json.Int(d, "startBy") ?? 0,
                SessionMs = Json.Int(d, "sessionMs") ?? 0,
                EndsAt = Json.Int(d, "endsAt") ?? 0,
                FirstLogonAt = Json.Int(d, "firstLogonAt") ?? 0,
                LastSeenAt = Json.Int(d, "lastSeenAt") ?? 0,
                Warned = warned is bool && (bool)warned,
                EndReason = Json.Str(d, "endReason"),
            };
        }
    }

    public sealed class LabState
    {
        public List<Student> Students = new List<Student>();
        public Reservation Reservation;

        public Dictionary<string, object> ToDict()
        {
            var students = new List<object>();
            foreach (Student s in Students) students.Add(s.ToDict());
            return new Dictionary<string, object>
            {
                { "version", 1 },
                { "students", students },
                { "reservation", Reservation == null ? null : Reservation.ToDict() },
            };
        }

        public static LabState FromDict(Dictionary<string, object> d)
        {
            var state = new LabState();
            if (d == null) return state;
            List<object> students = Json.List(d, "students");
            if (students != null)
            {
                foreach (object item in students)
                {
                    Student s = Student.FromDict(item as Dictionary<string, object>);
                    if (s != null && state.Students.TrueForAll(x => x.Account != s.Account)) state.Students.Add(s);
                }
            }
            state.Reservation = Reservation.FromDict(Json.Obj(d, "reservation"));
            if (state.Reservation != null && state.Students.TrueForAll(x => x.Account != state.Reservation.Account))
            {
                state.Reservation = null;
            }
            return state;
        }
    }

    public interface IStateStore
    {
        LabState Load();
        void Save(LabState state);
    }

    // %ProgramData%\OpenPortal\lab\state.json, gravado por inteiro num arquivo
    // temporário e trocado de uma vez: uma queda no meio não deixa meio arquivo.
    public sealed class FileStateStore : IStateStore
    {
        private readonly string path;

        public FileStateStore(string path)
        {
            this.path = path;
        }

        public LabState Load()
        {
            try
            {
                if (!File.Exists(path)) return new LabState();
                return LabState.FromDict(Json.ParseObject(File.ReadAllText(path, Encoding.UTF8)));
            }
            catch
            {
                return new LabState();
            }
        }

        public void Save(LabState state)
        {
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, Json.Write(state.ToDict()), new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
    }

    public sealed class MemoryStateStore : IStateStore
    {
        private string saved;

        public LabState Load()
        {
            return saved == null ? new LabState() : LabState.FromDict(Json.ParseObject(saved));
        }

        public void Save(LabState state)
        {
            saved = Json.Write(state.ToDict());
        }

        public string Raw
        {
            get { return saved; }
        }
    }
}
