package main

import "testing"

func TestRupees(t *testing.T) {
	for in, want := range map[int64]string{0: "0.00", 5: "0.05", 12345: "123.45", 153315200: "15,33,152.00", 100000000000: "1,00,00,00,000.00", -98700: "-987.00"} {
		if got := rupees(in); got != want {
			t.Errorf("rupees(%d) = %q, want %q", in, got, want)
		}
	}
}
