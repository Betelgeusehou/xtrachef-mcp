# Step-by-step walkthrough (no coding experience needed)

This guide takes you from nothing to asking Claude questions about your invoice
data. Budget about 20 minutes. You do not need to know how to code — if you can
export a report from xtraCHEF, you can do this.

## What you're setting up, in plain English

xtraCHEF holds all your invoice data but has no way for other software to ask it
questions. It does let you download your invoices as a spreadsheet (CSV). This
tool watches for those downloads, files every line item into a little database
on your computer, and lets Claude answer questions against it — price history on
any item, which prices are creeping up, what you spent with each vendor. Nothing
is uploaded anywhere. Your data stays on your machine.

## Step 1 — Install the two programs you need

1. **Node.js** (the engine this tool runs on): go to [nodejs.org](https://nodejs.org),
   download the "LTS" version, run the installer, accept all defaults.
2. **Claude Desktop** (if you don't already use it): [claude.ai/download](https://claude.ai/download).
   Claude Code and Cowork work too — any of them can use this tool.

## Step 2 — Get this tool onto your computer

Easiest path, no terminal required:

1. On this repository's GitHub page, click the green **Code** button → **Download ZIP**.
2. Unzip it somewhere permanent — e.g. your Documents folder. (Not your
   Downloads folder, and don't move it later; Claude will need its location.)

Then open the app you use for Claude and paste this prompt:

> I just unzipped a tool called xtrachef-mcp into [tell it where].
> Please run "npm install" in that folder, then register it as an MCP server
> named "xtrachef" in my configuration, pointing at src/main.js in that folder.
> Then restart instructions please.

Claude will do the install and wiring for you. Restart the app when it says to.

## Step 3 — Export your invoices from xtraCHEF

1. Log in at **app.xtrachef.com**.
2. In the left menu, under *Invoice Automation*, click **Invoices**.
3. Set the upload-date filter to a big range — go back a year if you can.
4. Click **Download** (top right of the invoice table). A file named
   `Invoices_YourBusinessName_....csv` lands in your Downloads folder.

⚠️ Use the **Invoices** page Download, not the Excel button on *Search
invoices* — that one only exports invoice totals, not the line items.

## Step 4 — Load the data

Ask Claude:

> Run xtrachef_ingest_downloads

It finds the file in Downloads, loads every line item, and tells you how many
it added. You can sanity-check anytime with:

> Run xtrachef_status

## Step 5 — Ask questions

Some starters:

- *What's the price history on chicken wings?*
- *Which items went up more than 10% since June?*
- *What did we spend with each vendor last month?*
- *Show me every line item from Sysco over $200 this quarter.*
- *Break down last month's spend by GL code.*

## Keeping it fresh

Once a week (or whenever you care), repeat Steps 3–4: export from xtraCHEF,
then "run xtrachef_ingest_downloads." Overlapping date ranges are fine — it
never double-counts a line it has already seen. Each export takes about a
minute.

## If something goes wrong

- **Claude says it has no xtrachef tools** → restart the Claude app fully and
  start a new conversation. MCP servers only connect when a session starts.
- **Ingest says "not an xtraCHEF invoice line export"** → you probably used the
  Search-invoices Excel button. Re-export from the Invoices page.
- **Numbers look short** → check `xtrachef_status`; the upload-date range shows
  exactly what's covered. Export the missing range and ingest again.
