using System;
using System.Threading;

namespace OpenPortalLab
{
    // Relógio e espera injetáveis: o serviço usa o relógio de verdade, o teste
    // um relógio falso que avança sem esperar.
    public interface IClock
    {
        long NowMs { get; }
        void Sleep(int ms);
    }

    public sealed class SystemClock : IClock
    {
        public long NowMs
        {
            get { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
        }

        public void Sleep(int ms)
        {
            if (ms > 0) Thread.Sleep(ms);
        }
    }

    public interface IRandom
    {
        // Inteiro uniforme em [0, max).
        int Next(int max);
    }

    public sealed class SecureRandom : IRandom
    {
        private readonly System.Security.Cryptography.RandomNumberGenerator rng =
            System.Security.Cryptography.RandomNumberGenerator.Create();

        public int Next(int max)
        {
            if (max <= 0) throw new ArgumentOutOfRangeException("max");
            // Rejeição para não enviesar o resto da divisão.
            uint limit = uint.MaxValue - (uint.MaxValue % (uint)max);
            var bytes = new byte[4];
            while (true)
            {
                rng.GetBytes(bytes);
                uint value = BitConverter.ToUInt32(bytes, 0);
                if (value < limit) return (int)(value % (uint)max);
            }
        }
    }
}
