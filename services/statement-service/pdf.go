package main

import (
	"fmt"
	"io"
	"time"

	"github.com/go-pdf/fpdf"
)

var (
	brand = [3]int{14, 90, 99}
	ink   = [3]int{22, 36, 43}
	muted = [3]int{100, 116, 139}
	line  = [3]int{226, 232, 240}
	zebra = [3]int{246, 249, 250}
)

// Column layout for the transactions table (A4 portrait, 15 mm margins = 180 mm wide).
var cols = []struct {
	title string
	width float64
	align string
}{
	{"Date", 26, "L"}, {"Description", 64, "L"}, {"Debit (Rs.)", 30, "R"}, {"Credit (Rs.)", 30, "R"}, {"Balance (Rs.)", 30, "R"},
}

func writePDF(w io.Writer, a *account, c customer, p period, sum summary, items []entry) error {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(15, 15, 15)
	pdf.SetAutoPageBreak(true, 18)
	pdf.SetTitle("VijayBank account statement", true)
	pdf.SetAuthor("VijayBank (fictional)", true)
	generated := time.Now().In(ist).Format("02 Jan 2006, 15:04 IST")

	pdf.SetFooterFunc(func() {
		pdf.SetY(-13)
		pdf.SetFont("Helvetica", "", 7.5)
		setText(pdf, muted)
		pdf.CellFormat(120, 5, "Computer-generated statement - no signature required. VijayBank is a fictional bank; all data is simulated.", "", 0, "L", false, 0, "")
		pdf.CellFormat(60, 5, fmt.Sprintf("Page %d of {nb}", pdf.PageNo()), "", 0, "R", false, 0, "")
	})
	pdf.AliasNbPages("{nb}")
	tableHeader := func() {
		pdf.SetFont("Helvetica", "B", 8.5)
		pdf.SetFillColor(brand[0], brand[1], brand[2])
		pdf.SetTextColor(255, 255, 255)
		for _, col := range cols {
			pdf.CellFormat(col.width, 7, col.title, "", 0, col.align, true, 0, "")
		}
		pdf.Ln(-1)
	}
	pdf.SetHeaderFunc(func() {
		if pdf.PageNo() > 1 {
			pdf.SetFont("Helvetica", "B", 9)
			setText(pdf, brand)
			pdf.CellFormat(90, 6, "VijayBank - Account statement", "", 0, "L", false, 0, "")
			setText(pdf, muted)
			pdf.SetFont("Helvetica", "", 8)
			pdf.CellFormat(90, 6, "A/c "+a.AccountNo, "", 1, "R", false, 0, "")
			pdf.Ln(2)
			tableHeader()
		}
	})

	pdf.AddPage()

	// Brand bar
	pdf.SetFillColor(brand[0], brand[1], brand[2])
	pdf.Rect(0, 0, 210, 26, "F")
	pdf.SetFillColor(245, 185, 66)
	pdf.Rect(15, 8, 10, 10, "F")
	pdf.SetXY(28, 8)
	pdf.SetFont("Helvetica", "B", 18)
	pdf.SetTextColor(255, 255, 255)
	pdf.CellFormat(80, 10, "VijayBank", "", 0, "L", false, 0, "")
	pdf.SetFont("Helvetica", "", 11)
	pdf.SetXY(110, 8)
	pdf.CellFormat(85, 10, "Account Statement", "", 0, "R", false, 0, "")
	pdf.SetY(34)

	// Customer and account blocks
	left := [][2]string{{"Customer", c.FullName}, {"Address", c.Address}, {"City", c.City}, {"Customer ID", a.CustomerID}}
	right := [][2]string{
		{"Account number", a.AccountNo}, {"Account type", titleCase(a.Type)}, {"Branch", a.Branch}, {"IFSC", a.Ifsc},
		{"Period", p.from.Format("02 Jan 2006") + " to " + p.to.Format("02 Jan 2006")}, {"Generated", generated},
	}
	y := pdf.GetY()
	kv(pdf, 15, y, left)
	kv(pdf, 108, y, right)
	pdf.SetY(y + float64(max(len(left), len(right)))*5.5 + 4)

	// Summary
	pdf.SetDrawColor(line[0], line[1], line[2])
	boxes := [][2]string{
		{"Opening balance", rupees(sum.OpeningBalancePaise)},
		{"Total credits", rupees(sum.TotalCreditsPaise)},
		{"Total debits", rupees(sum.TotalDebitsPaise)},
		{"Closing balance", rupees(sum.ClosingBalancePaise)},
	}
	y = pdf.GetY()
	for i, b := range boxes {
		x := 15 + float64(i)*45
		pdf.SetFillColor(zebra[0], zebra[1], zebra[2])
		pdf.Rect(x, y, 43, 16, "FD")
		pdf.SetXY(x+3, y+2.5)
		pdf.SetFont("Helvetica", "", 7.5)
		setText(pdf, muted)
		pdf.CellFormat(37, 4, b[0], "", 2, "L", false, 0, "")
		pdf.SetX(x + 3)
		pdf.SetFont("Helvetica", "B", 10.5)
		setText(pdf, ink)
		pdf.CellFormat(37, 7, "Rs. "+b[1], "", 0, "L", false, 0, "")
	}
	pdf.SetY(y + 22)

	// Transactions
	pdf.SetFont("Helvetica", "B", 10)
	setText(pdf, ink)
	pdf.CellFormat(180, 6, fmt.Sprintf("Transactions (%d)", len(items)), "", 1, "L", false, 0, "")
	pdf.Ln(1)
	tableHeader()
	pdf.SetFont("Helvetica", "", 8)
	if len(items) == 0 {
		setText(pdf, muted)
		pdf.CellFormat(180, 9, "No transactions in this period.", "", 1, "C", false, 0, "")
	}
	for i, e := range items {
		fill := i%2 == 1
		pdf.SetFillColor(zebra[0], zebra[1], zebra[2])
		debit, credit := "", ""
		if e.Direction == "DEBIT" {
			debit = rupees(e.AmountPaise)
		} else {
			credit = rupees(e.AmountPaise)
		}
		values := []string{e.PostedAt.In(ist).Format("02 Jan 2006"), fit(pdf, e.Narration, cols[1].width-2), debit, credit, rupees(e.BalanceAfterPaise)}
		for j, col := range cols {
			switch {
			case j == 2 && debit != "":
				pdf.SetTextColor(180, 35, 24)
			case j == 3 && credit != "":
				pdf.SetTextColor(21, 128, 61)
			default:
				setText(pdf, ink)
			}
			pdf.CellFormat(col.width, 6.2, values[j], "", 0, col.align, fill, 0, "")
		}
		pdf.Ln(-1)
	}
	pdf.SetDrawColor(brand[0], brand[1], brand[2])
	pdf.Line(15, pdf.GetY(), 195, pdf.GetY())
	pdf.Ln(2)
	pdf.SetFont("Helvetica", "B", 9)
	setText(pdf, ink)
	pdf.CellFormat(150, 6, "Closing balance", "", 0, "R", false, 0, "")
	pdf.CellFormat(30, 6, rupees(sum.ClosingBalancePaise), "", 1, "R", false, 0, "")

	return pdf.Output(w)
}

func kv(pdf *fpdf.Fpdf, x, y float64, rows [][2]string) {
	for i, r := range rows {
		pdf.SetXY(x, y+float64(i)*5.5)
		pdf.SetFont("Helvetica", "", 8)
		setText(pdf, muted)
		pdf.CellFormat(28, 5, r[0], "", 0, "L", false, 0, "")
		pdf.SetFont("Helvetica", "B", 8.5)
		setText(pdf, ink)
		pdf.CellFormat(58, 5, fit(pdf, r[1], 58), "", 0, "L", false, 0, "")
	}
}

func setText(pdf *fpdf.Fpdf, c [3]int) { pdf.SetTextColor(c[0], c[1], c[2]) }

// fit truncates text with "..." so it fits the given width in the current font.
func fit(pdf *fpdf.Fpdf, s string, width float64) string {
	if pdf.GetStringWidth(s) <= width {
		return s
	}
	for len(s) > 0 && pdf.GetStringWidth(s+"...") > width {
		s = s[:len(s)-1]
	}
	return s + "..."
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	b := []byte(s)
	for i := 1; i < len(b); i++ {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
