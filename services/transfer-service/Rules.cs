using System.Text.RegularExpressions;

namespace VijayBank.Transfers;

/// <summary>Simulated transfer rules (see docs/DESIGN.md section 5.3). Amounts in paise.</summary>
public static partial class Rules
{
    public const long Rupee = 100;
    public const long Lakh = 1_00_000 * Rupee;

    public const long DailyLimit = 10 * Lakh;
    public const long NewBeneficiaryLimit = 50_000 * Rupee;
    public static readonly TimeSpan NewBeneficiaryWindow = TimeSpan.FromHours(24);

    public static readonly string[] Modes = ["OWN", "INTRA", "IMPS", "NEFT", "RTGS"];

    /// <summary>Returns an error message when the amount is outside the mode's per-transaction range.</summary>
    public static string? CheckAmount(string mode, long amount) => mode switch
    {
        _ when amount < 1 * Rupee => "The minimum transfer amount is ₹1.",
        "OWN" or "INTRA" when amount > 10 * Lakh => "Transfers within VijayBank are limited to ₹10,00,000 per transaction.",
        "IMPS" when amount > 5 * Lakh => "IMPS transfers are limited to ₹5,00,000 per transaction. Use NEFT or RTGS.",
        "NEFT" when amount > 10 * Lakh => "NEFT transfers are limited to ₹10,00,000 per transaction.",
        "RTGS" when amount < 2 * Lakh => "RTGS is for ₹2,00,000 and above. Use IMPS or NEFT.",
        _ => null,
    };

    /// <summary>Fictional banks by IFSC prefix.</summary>
    private static readonly Dictionary<string, string> Banks = new()
    {
        ["VIJB"] = "VijayBank",
        ["BCBK"] = "Bharat Commerce Bank",
        ["SNBK"] = "Sahyadri National Bank",
        ["DCOB"] = "Deccan Co-operative Bank",
        ["OTHB"] = "Other Bank",
    };

    public static string BankName(string ifsc) => Banks.GetValueOrDefault(ifsc[..4], "Other Bank");
    public static bool IsInternal(string ifsc) => ifsc.StartsWith("VIJB", StringComparison.Ordinal);

    [GeneratedRegex("^[A-Z]{4}0[A-Z0-9]{6}$")]
    public static partial Regex Ifsc();

    [GeneratedRegex("^[0-9]{9,18}$")]
    public static partial Regex AccountNo();

    public static string Mask(string accountNo) => "XX" + accountNo[^Math.Min(4, accountNo.Length)..];

    /// <summary>Start of the current IST calendar day, expressed in UTC.</summary>
    public static DateTime IstMidnightUtc(DateTime utcNow) =>
        DateTime.SpecifyKind(utcNow.AddHours(5.5).Date.AddHours(-5.5), DateTimeKind.Utc);

    public static string NewReference(string mode) =>
        $"VB{mode[0]}{DateTime.UtcNow.AddHours(5.5):yyMMdd}{Random.Shared.Next(0, 1_000_000):D6}";
}
