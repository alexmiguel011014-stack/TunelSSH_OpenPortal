using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenPortalLab
{
    // Nome de conta do Windows derivado do nome que o professor digita:
    // ASCII minúsculo, até 12 caracteres, único e nunca igual a uma conta que já
    // existe (nem a um nome reservado). O serviço só mexe em contas que ele mesmo
    // criou, então o nome nunca vem de texto livre do pedido.
    public static class Names
    {
        public const int MaxLength = 12;
        public const string Fallback = "aluno";

        private static readonly Regex AccountPattern = new Regex("^[a-z0-9]{1,12}$", RegexOptions.CultureInvariant);

        private static readonly HashSet<string> Reserved = new HashSet<string>(StringComparer.Ordinal)
        {
            "administrator", "administrador", "admin", "guest", "convidado", "system",
            "defaultaccount", "wdagutilityaccount", "openportal", "root", "user", "users",
            "public", "default", "all", "everyone", "network", "service", "local",
            "labtest1", "labtest2",
        };

        public static bool IsValidAccount(string account)
        {
            return account != null && AccountPattern.IsMatch(account);
        }

        // Só letras e números ASCII, sem acento; vazio se não sobrar nada.
        public static string Slug(string label)
        {
            if (string.IsNullOrEmpty(label)) return "";
            string decomposed = label.Normalize(NormalizationForm.FormD);
            var builder = new StringBuilder();
            foreach (char c in decomposed)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
                char lower = char.ToLowerInvariant(c);
                if ((lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9')) builder.Append(lower);
            }
            return builder.ToString();
        }

        // `taken` diz se o nome já está em uso (conta do Windows ou aluno já criado).
        // Devolve null só se nem com sufixos achar um nome livre.
        public static string Derive(string label, Func<string, bool> taken)
        {
            string slug = Slug(label);
            if (slug.Length == 0) slug = Fallback;
            // Um nome reservado também vale pelo que digitaram por inteiro ("administrador"
            // cortado em 12 viraria "administrado", que não está na lista).
            bool reservedAsTyped = Reserved.Contains(slug);
            if (slug.Length > MaxLength) slug = slug.Substring(0, MaxLength);

            if (!reservedAsTyped && IsFree(slug, taken)) return slug;
            for (int n = 2; n < 1000; n++)
            {
                string suffix = n.ToString(CultureInfo.InvariantCulture);
                string head = slug.Length + suffix.Length > MaxLength ? slug.Substring(0, MaxLength - suffix.Length) : slug;
                string candidate = head + suffix;
                if (IsFree(candidate, taken)) return candidate;
            }
            return null;
        }

        private static bool IsFree(string candidate, Func<string, bool> taken)
        {
            return IsValidAccount(candidate) && !Reserved.Contains(candidate) && !taken(candidate);
        }

        // O nome de exibição: sem caracteres de controle, de 1 a 40 caracteres.
        public static string CleanLabel(string label)
        {
            if (label == null) return null;
            string trimmed = label.Trim();
            int length = new StringInfo(trimmed).LengthInTextElements;
            if (length < 1 || length > 40) return null;
            foreach (char c in trimmed)
            {
                if (char.IsControl(c)) return null;
            }
            return trimmed;
        }
    }
}
