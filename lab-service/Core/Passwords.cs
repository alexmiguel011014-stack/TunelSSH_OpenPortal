using System.Text;

namespace OpenPortalLab
{
    // Senha da conta do aluno: aleatória, nova a cada reserva, nunca guardada.
    // Letras e números sem os que se confundem (0/O, 1/l/I), com pelo menos uma
    // maiúscula, uma minúscula e um número — três das quatro classes que a política
    // de complexidade do Windows pede — e sem símbolos, para ditar e digitar bem.
    public static class Passwords
    {
        public const int Length = 16;
        private const string Upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        private const string Lower = "abcdefghijkmnopqrstuvwxyz";
        private const string Digits = "23456789";

        public static string Generate(IRandom random)
        {
            string all = Upper + Lower + Digits;
            var chars = new char[Length];
            chars[0] = Upper[random.Next(Upper.Length)];
            chars[1] = Lower[random.Next(Lower.Length)];
            chars[2] = Digits[random.Next(Digits.Length)];
            for (int i = 3; i < Length; i++) chars[i] = all[random.Next(all.Length)];
            // Embaralha (Fisher-Yates) para as três garantidas não ficarem sempre no começo.
            for (int i = Length - 1; i > 0; i--)
            {
                int j = random.Next(i + 1);
                char swap = chars[i];
                chars[i] = chars[j];
                chars[j] = swap;
            }
            return new string(chars);
        }

        public static bool MeetsPolicy(string password)
        {
            if (password == null || password.Length != Length) return false;
            bool upper = false, lower = false, digit = false;
            foreach (char c in password)
            {
                if (c >= 'A' && c <= 'Z') upper = true;
                else if (c >= 'a' && c <= 'z') lower = true;
                else if (c >= '0' && c <= '9') digit = true;
                else return false;
            }
            return upper && lower && digit;
        }
    }
}
