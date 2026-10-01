using System;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace OpenPortalLab
{
    // JSON simples sobre JavaScriptSerializer (já faz parte do .NET Framework).
    // Os pedidos viram dicionários; os getters abaixo só devolvem o tipo certo,
    // senão null — quem valida decide o que fazer com um campo ausente ou torto.
    public static class Json
    {
        private static JavaScriptSerializer Make()
        {
            return new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024, RecursionLimit = 20 };
        }

        public static Dictionary<string, object> ParseObject(string text)
        {
            try
            {
                return Make().DeserializeObject(text) as Dictionary<string, object>;
            }
            catch
            {
                return null;
            }
        }

        public static string Write(object value)
        {
            return Make().Serialize(value);
        }

        public static string Str(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) ? value as string : null;
        }

        // Inteiro de verdade: aceita int/long e decimal/double sem parte fracionária.
        public static long? Int(Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null) return null;
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            if (value is decimal)
            {
                decimal d = (decimal)value;
                return d == Math.Truncate(d) && Math.Abs(d) < 9e15m ? (long?)d : null;
            }
            if (value is double)
            {
                double d = (double)value;
                return d == Math.Truncate(d) && Math.Abs(d) < 9e15 ? (long?)d : null;
            }
            return null;
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }

        public static List<object> List(Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value)) return null;
            var arrayList = value as ArrayList;
            if (arrayList != null) return new List<object>(arrayList.ToArray());
            var objects = value as object[];
            return objects != null ? new List<object>(objects) : null;
        }
    }
}
