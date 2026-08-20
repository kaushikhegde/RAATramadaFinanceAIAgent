# Supplier name cheat sheet

`supplier-names.xlsx` — RAA's own file, received 20-Aug-2026. **One sheet, both
reports.**

The two guides each name their own ("MINT Supplier Name Cheat Sheet", "TravelPay
Supplier Name Cheat Sheet") as though there were two. RAA's actual file is headed

| SUPPLIER NAME IN MINT / TRAVELPAY | IN TRAMADA - TRY THESE |
|---|---|

so it is kept as one. Upload it once and MINT and TravelPay both use it.

## Why it exists

The spreadsheets name the **legal entity**; Tramada names the **trading name**.

| the spreadsheet says | Tramada calls it |
|---|---|
| `Websource Pacific Pty Limited` | `Stuba` |
| `Great Southern Rail Travel Pty Ltd` | `Journey Beyond` |
| `Emerald Cruises` | `Scenic Tours` |

Without a mapping, BR05's third gate reports `Supplier does not match` and the
row is not ticked — a naming failure wearing the clothes of a money failure.

## "TRY THESE" is plural

One row can name several creditors, and the row matches if Tramada's name is any
of them. The sheet uses two separators:

```
RCL CRUISES LTD         →  Royal Caribbean / Celebrity Cruises
Circuit Travel Pty Ltd  →  Cosmos Tours, Globus, Avalon Waterways
```

**The whole cell is always kept as a candidate as well as the pieces**, so
splitting can only ever add a name and never lose one. That matters because both
separators appear inside real company names — `Broome, Kimberley & Beyond Pty
Ltd` has the comma and `Viva Holidays II Limited T/A Ready Rooms` has the slash.
A slash only separates with space around it (` / `), which is how this sheet
writes it and is never how `T/A` or `P/L` is written.

## Near misses are named, never acted on

The left column does not always match the spreadsheet character for character.
The MINT file says `Trafalgar Tours (Aust) Pty Ltd`; this sheet's row is
`Trafalgar Tours`.

The row **stops**, and the remark says which line to add:

> Supplier does not match — the page pays "Costsaver", the file says "Trafalgar
> Tours (Aust) Pty Ltd" — not in the cheat sheet (the sheet has "Trafalgar Tours"
> — add this exact name to it if they are the same creditor)

Those two are probably the same company. Probably is not good enough to tick
money onto a bank statement that then gets committed, and the fix is one line
typed by somebody who knows.

## What is not in it

Twelve of the nineteen suppliers in the dummy MINT file are not in this sheet,
and that is correct — **the sheet is a list of the known exceptions, not a
directory.** A supplier whose name is the same on both sides needs no row: the
match is tried exactly first, and only then through the sheet.

Two mappings confirmed live in Tramada on 17-Aug-2026 are *not* in this file and
were deliberately not merged in, so that what the app uses is exactly what
Finance maintains:

| the spreadsheet says | Tramada has |
|---|---|
| `Viva Holidays II Limited T/A Ready Rooms` | `READY ROOMS` |
| `Viva Holidays Pty Ltd` | `Viva Holidays` |

The second one needs resolving before it is added: this sheet maps
`Viva Holidays` → `My Way Travel & Events Pty Ltd`, and Tramada also has a
creditor called `Viva Holidays`.

## Format and upload

Excel or CSV, two columns, a heading row. Any of these headings are recognised on
the left — `Supplier Name in MINT / TravelPay`, `Spreadsheet Name`, `Supplier` —
and on the right, `In Tramada - Try These`, `Tramada Creditor`, `Creditor`. A
two-column file with headings nobody recognises is still read left-to-right,
and the panel says so.

Upload it on **Sources & upload**. It replaces whatever was there, and the panel
shows the file name, how many suppliers it holds and when it went up. Until
something is uploaded, the app uses this file as shipped.

A row with a blank right-hand column is skipped and counted, so a half-filled
sheet is visible rather than silently partial.
