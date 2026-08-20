# Supplier name cheat sheets

MINT and TravelPay both need one (their guides, step 12 and BR05). It exists
because the two systems name the same company differently:

| the spreadsheet says | Tramada calls it |
|---|---|
| `Viva Holidays II Limited T/A Ready Rooms` | `READY ROOMS` |
| `Viva Holidays Pty Ltd` | `Viva Holidays` |

The file names the **legal entity**; Tramada names the **trading name**. "T/A"
in that first row is the spreadsheet telling you so. Without a mapping, BR05's
third gate reports `Supplier does not match` and the row is not ticked — a
naming failure wearing the clothes of a money failure.

## The format

Two columns, a heading row, CSV:

```csv
Spreadsheet Name,Tramada Creditor
Viva Holidays II Limited T/A Ready Rooms,READY ROOMS
```

Upload it on Sources & upload. It replaces whatever was there, and the panel
shows the file name, how many names it holds and when it went up.

## What is in these two files, and what is not

`mint-supplier-names.csv` holds all **19** distinct `To Company` values from the
dummy MINT file. **Two are filled in. Seventeen are deliberately blank.**

The two were confirmed by searching Tramada's own Creditor Search on
17-Aug-2026 — `READY ROOMS` and `Viva Holidays` both came back as real
creditors. The other seventeen were not confirmed, so they are empty.

**A blank means "nobody has checked", not "no mapping needed".** They were left
blank rather than guessed at, and that is the whole discipline of this file: a
guessed mapping ticks a payment against a creditor nobody verified, on a bank
statement that then gets committed. `Scenic Tours Pty Ltd` probably maps to
`Scenic Tours`, and probably is not good enough here.

A row with a blank right-hand column is skipped, and the upload panel says how
many were skipped — so a half-filled sheet is visible rather than silently
partial.

## Filling in the rest

For each blank, search Tramada → Creditors → Creditor Search by company name and
paste the **Creditor Name** exactly as Tramada shows it. Anything still blank
keeps failing on the supplier gate, which is the safe way round.
