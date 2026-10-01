using System;
using System.Collections.Generic;

namespace OpenPortalLab
{
    // Quantos alunos o disco comporta (GOALS 17, G17-I9). É uma recomendação e um
    // aviso, nunca um bloqueio: floor((livre − reserva) ÷ cota), com reserva de
    // 20% do disco ou 20 GB, o que for maior (editável pelo professor).
    public static class Capacity
    {
        public const double MinimumReserveGb = 20;
        public const double ReserveFraction = 0.2;

        public static double DefaultReserveGb(double totalGb)
        {
            return Math.Max(totalGb * ReserveFraction, MinimumReserveGb);
        }

        // `status`: "ok" cabe e sobra espaço para mais um aluno na cota padrão;
        // "tight" cabe, mas não sobra espaço para mais um; "over" as cotas somadas
        // passam do que está livre além da reserva.
        public static Dictionary<string, object> Compute(
            double totalGb, double freeGb, double quotaGb, double assignedGb, double? reserveGb)
        {
            if (quotaGb <= 0) quotaGb = 25;
            double reserve = reserveGb.HasValue && reserveGb.Value >= 0 ? reserveGb.Value : DefaultReserveGb(totalGb);
            double room = Math.Max(0, freeGb - reserve);
            int recommended = (int)Math.Floor(room / quotaGb + 1e-9);

            string status = "ok";
            if (assignedGb > freeGb - reserve + 1e-9) status = "over";
            else if (assignedGb + quotaGb > freeGb - reserve + 1e-9) status = "tight";

            return new Dictionary<string, object>
            {
                { "totalGb", Round(totalGb) },
                { "freeGb", Round(freeGb) },
                { "reserveGb", Round(reserve) },
                { "quotaGb", Round(quotaGb) },
                { "recommended", recommended },
                { "assignedGb", Round(assignedGb) },
                { "status", status },
            };
        }

        private static double Round(double value)
        {
            return Math.Round(value, 1);
        }
    }
}
