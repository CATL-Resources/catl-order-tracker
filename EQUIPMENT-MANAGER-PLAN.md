# CATL Equipment Manager Build-Out Plan

> Written 2026-11-21 in a planning session with Chandy. The commentable copy is the doc at https://claude.ai/artifact/8v59ckayCaW5mV7Z6eNQTZ. If the two disagree, the doc wins and this file gets updated.
> Status: waiting on Chandy's approval. Nothing here is built yet.

## One-Page Summary

The finished Equipment Manager is one place where every lead, chute, and piece of paperwork is entered once, and you run it by tapping a screen or by messaging Claude Duet.

- **Leads do not get lost.** Website forms, Estimate Builder builds, phone calls, and voice memos land in one list. Each lead shows contact info, what they want, how hot it is, the last contact, the next follow-up, and who owns it.
- **Estimates stay in QuickBooks.** One tap or one sentence fills in a QuickBooks estimate from a build. Tim reviews and sends it from QuickBooks, so the accept button, payments, and the flip to an invoice work as they do today.
- **The send package is one action.** The estimate, its PDF, and the photos the customer asked for go out together.
- **One board per chute replaces Notion.** Progress, contract, both down payments, changes, modifications, trucking, attached paperwork, where it stands in QuickBooks, and paid or not.
- **Order truth is checked for you.** The accepted estimate is compared against Moly's order confirmation every time either one changes. Every change opens a checklist that stays open until each item is done.
- **Contacts log themselves.** Calls and emails attach to the right lead and chute, and follow-ups arrive already drafted.
- **The website runs from the same data.** Inventory, prices, photos, and product text are managed from the dashboard with no code.
- **A Monday summary arrives on its own.** Leads, estimates, website visitors, and anything broken.
- **A weekly tips email** goes to a signup list, and the tips also live on the website.
- **Freight** finishes the picture: runs, carriers, bills of lading.

### Two Ways To Run It

- **The dashboard** at catlapp.com shows the facts. Screens stay few and fixed.
- **Claude Duet** does the work around those facts in whatever way Chandy or Tim ask. It uses the same named actions the dashboard buttons use, so the rules are the same either way.
- **The database keeps the alarms.** Reminders and summaries run on a schedule, so nothing depends on a person or on Duet noticing.

### Defaults Used Where Chandy Had Not Answered

- Screens live in CATL Hub (catlapp.com). This repo (`catl-order-tracker`) keeps the robots, which are the background jobs that run on their own.
- The inside app keeps the Hub's dark look. Navy, cream, and gold with the Inter font is used for the public website and anything a customer sees.
- The app may create estimates in QuickBooks. Everything else in QuickBooks stays read-only.
- Notion is caught up once, then frozen as an archive.

## What I Found

| Problem | What it means | Fixed in |
| --- | --- | --- |
| The app's QuickBooks sign-in expired November 14 | Every QuickBooks action from the app fails until someone signs in again. It was last renewed August 5, and nothing renews it on a schedule. | Phase 0 |
| The screens live in two apps | The working Equipment screens (inventory, contacts, freight, repairs) are in CATL Hub at catlapp.com, last changed in September. `catl-order-tracker` holds older screens with no Vercel home, plus all 54 robots. | Phase 0 |
| Pipelines went quiet with no alarm | Last phone call logged November 9. Last voice memo and last auto-created task October 8. Email scanning is still running. | Phase 0 |
| Notion is more current than the database | The board was copied into the database in July, then Tim kept working in Notion. | Phase 3 |
| The app's own estimate builder is unused | 3 estimates in the app, newest from June. 58 units sit in "estimate" status. Estimating is happening in QuickBooks. | Phase 2 |
| Three doors into the leads table | One robot and two database functions all save website leads. Only 3 leads exist so far, all from the Estimate Builder on November 20. | Phase 0 |
| The new website is not launched | It sits on the `new-site` branch waiting on the text doc and photo picks. Its inventory list is an empty hand-edited file. | Phase 5 |

Already in good shape:

- **Leads are half built.** `web_leads` already stores hot or not, last contacted, notes, and status.
- **Freight is mostly built.** Carriers, freight runs, stops, and the freight screens exist.
- **The database is locked.** The main tables open only to signed-in users.
- **Contacts are flowing in.** 4,054 calls and 7,073 emails are logged and matched to customers.
- **The Moly check has its parts.** Six paperwork slots per chute, a robot that reads emailed PDFs, and a 99-row table that translates CATL item names to Moly's.

## How The Pieces Fit

```text
   Dashboard (catlapp.com)          Claude Duet + CATL Connector
   reads and taps                   named actions (same as the buttons)
            \                          /
             v                        v
Public Website  <-- prices out --  CRLE DATABASE  -- estimates -->  QuickBooks Online
(Estimate Builder, -- leads in -->  one home for  <-- paid status -- (estimates, payments)
 forms, on Vercel)                  leads, chutes,
                                    paperwork, contacts
             ^                        ^
            /                          \
   Robots (scheduled jobs,          Email (Gmail in, Resend out)
   alarms, reminders)                 ^ confirmations from Moly Ordering
```

Every screen, every Duet action, and every robot reads and writes the same database. QuickBooks stays the home for estimates and money, the website reads prices and inventory from the database, and Vercel hosts the website and counts its visitors.

## The Data Plan

The plan adds 8 small tables and about 20 columns, and reuses everything else.

### New Tables

| Table | What it stores | Phase |
| --- | --- | --- |
| `robot_heartbeats` | The last time each background job ran successfully, so a quiet one sets off an alarm. | 0 |
| `site_events` | Things visitors do on the website that Vercel does not count: Estimate Builder started, Estimate Builder finished, form sent. No personal details. | 0 |
| `site_stats_weekly` | A weekly copy of Vercel's visitor numbers, kept because Vercel only holds a short history. | 0 |
| `contact_links` | Which lead and which chute a call, email, voice memo, or note belongs to. It points at the existing record and never copies a transcript. | 1 |
| `unit_payments` | Each down payment on a chute: who paid whom, how much, and when. | 3 |
| `change_checks` | The checklist behind each order change: Moly updated, purchase order updated, estimate revised, shop sheet, freight. | 4 |
| `subscribers` | The weekly tips signup list, with the date each person joined or left. | 6 |
| `tips` | Each tip: title, text, publish date, and whether it is live on the website. | 6 |

### Changes To Existing Tables

| Table | Change | What it stores |
| --- | --- | --- |
| `web_leads` | Add next follow-up date, owner, heat (hot, warm, cold), link to the customer record, QuickBooks estimate number and status, and lost reason | Everything about a lead in one row. New sources are added for phone calls and voice memos, so this becomes the one leads list. |
| `tasks` | Add a link to the lead | Follow-up reminders reuse the existing task list. There is no second reminder system. |
| `estimates` | Add QuickBooks status, accepted date, and link to the lead | A read-only copy of each QuickBooks estimate. Once the customer accepts, the copy is frozen and becomes the baseline for the Moly check. |
| `orders` | Add show on website, website price, website blurb, and QuickBooks invoice balance | One row per chute. Paid or not is read from QuickBooks and never typed. |
| `order_document_slots` | Add two results to the check: matched and known difference | Whether each paperwork pair agrees. "Known difference" covers things like an extra pump ordered for inventory. |
| `change_orders` | Start using it (it exists and is empty) | One row per change to an order: what changed, who asked, and where it came from. |
| `base_models` and `model_options` | Add website description | Product text edited from the dashboard. |
| `freight_run_items` | Add loading stop | Where each unit is loaded. Today only the unloading stop is saved. |
| `email_log` | Start using it for the tips email | One row per send, so the Monday summary can count them. |

### Reused As Is

`customers`, `call_log`, `voice_memos`, `gmail_inbox`, `catalog_images`, `website_photo_picks`, `quick_builds`, `carriers`, `freight_runs`, `freight_run_stops`, `manufacturer_item_mappings`, `orange_sheet_items`, `repair_orders`.

### Duplicates To Clean Up

- **Three lead doors.** Keep the two database functions the website calls (`submit_web_lead` and `submit_contact_lead`) and retire the older `submit-lead` robot once nothing uses it.
- **Two name-translation tables.** `mfg_item_mapping` (36 rows) duplicates `manufacturer_item_mappings` (99 rows). Keep the larger one.
- **Three contract number columns** on `orders`: `mfg_contract_number`, `moly_contract_number`, and `contract_number`. Keep `mfg_contract_number` as the one identifier.
- **Two heat fields.** The new heat column replaces the yes or no `is_hot` column.
- **The website's hand-edited inventory file** duplicates the unsold units in the database. The site will read the database instead.
- **Advertising cost.** QuickBooks already holds those bills. They get tagged there and the totals are read back, with no second copy.
- **Dead weight.** `model_option_availability` is not read by anything, and two old backup tables can go once confirmed.

## The Build Order

Start with Phase 0, the repairs, because estimates, paid status, and the Moly check cannot work on a dead QuickBooks connection or on robots that fail silently.

| Phase | What | Module | Size | Depends on |
| --- | --- | --- | --- | --- |
| 0 | Repairs And Foundations | All | Small | Nothing |
| 1 | Leads | Leads Management | Medium | 0 |
| 2 | Claude Connector, QuickBooks Estimates, Send Package | Estimate Management | Large | 0, 1 |
| 3 | The Chute Board (replaces Notion) | Contract Management | Large | 0, 2 |
| 4 | Order Truth And The Change Log | Contract Management | Large | 2, 3 |
| 5 | Website Management And Analytics | Website And Analytics | Medium | 0, 3 |
| 6 | Marketing | Marketing | Medium | 5 |
| 7 | Freight Finish | Freight Management | Small | 3 |

- **Leads stay near the front.** They are half built and they are where sales are lost.
- **Website management moves back to Phase 5.** The send package and the chute board cost Tim hours today, and live website inventory needs clean chute data from Phase 3 first.
- **Visitor tracking starts in Phase 0 anyway.** Vercel keeps a short history, so the numbers start saving on day one and the screens come later.
- **The Claude connector comes early, in Phase 2.** Every phase after it ships with both a screen and Duet actions.
- **Freight stays last.** It is a finish job, since most of it exists.
- **The Monday summary starts in Phase 1** with leads only and gains a section in each later phase.

Each phase is usable on its own.

## Each Phase

### Phase 0: Repairs And Foundations

- **What gets built:**
    - A Reconnect QuickBooks button, a daily automatic renewal, and an alarm 14 days before the sign-in would lapse.
    - A heartbeat on every robot. A daily check emails equipment@catlresources.com in red when one goes quiet.
    - The call and voice memo pipelines restarted, with the cause written down.
    - One door for website leads.
    - Vercel visitor counting turned on, plus our own counts for Estimate Builder starts and finishes, plus the weekly copy.
    - The old Lovable connection removed so it cannot overwrite the robots.
    - A test that Chandy's Duet can read and write the database.
- **Screens:** one System Health card on the dashboard, green or red per robot, with days left on the QuickBooks sign-in.
- **Done means:** QuickBooks answers from the app, a robot stopped on purpose triggers a red email within a day, and yesterday's phone calls show up.
- **Size:** Small.
- **Depends on:** Chandy signing in to QuickBooks once (two minutes).

### Phase 1: Leads

- **What gets built:**
    - Every source in one list: contact form, Get A Price form, Estimate Builder, phone calls, voice memos.
    - A call or memo from an unknown number suggests a new lead. Tim confirms with one tap.
    - A 7 AM list of follow-ups due, sent to Tim.
    - A flag on any website lead with no contact inside 24 hours.
    - The first Monday summary.
- **Screens:**
    - Leads List, phone-first cards with filters for Due Today, Hot, New, and All.
    - Lead Detail with the build they submitted, the timeline of calls and emails, and buttons for Call, Log Contact, Set Follow-Up, Won, and Lost.
    - Add Lead, a short form for phone-ins.
- **Done means:** a website submission appears within a minute, no open lead exists without a next follow-up date, and Tim can work his due list one-handed.
- **Size:** Medium.
- **Depends on:** Phase 0.

### Phase 2: Claude Connector, QuickBooks Estimates, Send Package

- **What gets built:**
    - The named actions, built as database functions so the dashboard, Duet, and regular Claude all call the same ones.
    - The CATL Equipment connector, a thin wrapper that shows those actions to Claude by name.
    - A CATL equipment skill, the written playbook Claude reads: how sales run, what an estimate needs, how Tim words things.
    - Make Estimate: a build or a spoken description becomes a QuickBooks estimate with the right line items at today's catalog prices.
    - Send Package: pick photos, attach them to the QuickBooks estimate, and QuickBooks sends the PDF, the photos, and the accept button together. Nothing leaves without an approval tap.
    - A read-back every 30 minutes, so each lead shows Sent, Accepted, or Declined by itself.
    - A ten-minute spoken interview with Tim. His answers shape the playbook and his chute screen.
- **Screens:** a Make Estimate button and an estimate status chip on the lead, plus a photo picker.
- **Done means:** an Estimate Builder lead becomes a QuickBooks estimate in under a minute with a matching total, the package arrives as one email, and all of it works by messaging Duet.
- **Size:** Large.
- **Depends on:** Phases 0 and 1.

### Phase 3: The Chute Board

- **What gets built:**
    - A one-time catch-up from Notion. Chandy sees the list of differences before anything is written.
    - Down payments, both directions.
    - Paid or not, read from QuickBooks.
    - Changes and modifications logged by tap or by message.
    - Paperwork attached to each chute and visible in one place.
    - Notion frozen as an archive.
- **Screens:**
    - Chute Screen for Tim's phone: progress, contract, down payments, paid status, changes, modifications, trucking, paperwork.
    - Needs Me Today, a short list across all chutes.
- **Done means:** Tim can answer "where is this chute and what is left" from one screen, and nobody opens Notion for a week.
- **Size:** Large.
- **Depends on:** Phases 0 and 2.

### Phase 4: Order Truth And The Change Log

- **What gets built:**
    - Moly's confirmation emails are read and filed to the right chute by contract number.
    - The accepted QuickBooks estimate is compared to the Moly confirmation, option by option. The result is Matched, Mismatch, or Known Difference.
    - The check reruns whenever either side changes.
    - Every change opens a checklist. A new Moly confirmation that shows the change closes the Moly item by itself.
    - Calls and emails attach to the chute, not only to the customer.
    - The two later checks follow the same pattern: purchase order against Moly's invoice, and estimate against the customer invoice with the margin check.
- **Screens:** an Order Check panel on the chute screen with Accept Difference and Flag buttons, a Changes tab, and a Mismatches list on the dashboard.
- **Done means:** a wrong option on a Moly confirmation is flagged within 30 minutes of the email arriving, with nobody opening it.
- **Size:** Large.
- **Depends on:** Phases 2 and 3.

### Phase 5: Website Management And Analytics

- **What gets built:**
    - Website inventory reads live from unsold chutes marked Show On Website.
    - Product text and photo picks are edited from the dashboard. Prices already flow from the catalog and stay read-only here.
    - Visitor numbers from Vercel next to our own counts.
    - The Monday summary gains a website section.
- **Screens:**
    - Website tab: Inventory, Product Text, Photos.
    - Analytics page: visitors, top pages, where they came from, phone or computer, Estimate Builder starts against finishes, forms sent, and leads to estimates to accepted.
- **Done means:** marking a chute Show On Website puts it live within five minutes with no code.
- **Size:** Medium.
- **Depends on:** Phases 0 and 3. Launching the new site itself is separate and still waits on the text doc and photo picks.

### Phase 6: Marketing

- **What gets built:**
    - A tips library. Each tip is written once and appears on the website and in the weekly email.
    - A signup form on the website and the subscriber list.
    - The weekly send, with links that show which tip or email brought a visit or an Estimate Builder start.
    - Advertising cost read from QuickBooks by tag. The tax treatment is left to the CPA.
- **Screens:** Tips list and editor, Subscribers, and an Email Results section on the Analytics page.
- **Done means:** a tip written on Monday is on the site and in Friday's email, and the Monday summary names the tip that brought the most visits.
- **Size:** Medium.
- **Depends on:** Phase 5 and the choice of email service.

### Phase 7: Freight Finish

- **What gets built:** the loading stop fix, a bill of lading document per run, carrier rates, and Duet actions for freight.
- **Screens:** the existing Freight board and run builder, plus a Bill Of Lading button.
- **Done means:** a run built on the phone produces a bill of lading and shows on each chute's screen.
- **Size:** Small.
- **Depends on:** Phase 3.

## Risks And Gotchas

### QuickBooks

- **The sign-in lapses if it is not renewed.** It lapsed November 14. Phase 0 adds the daily renewal and the early alarm.
- **The app only creates estimates.** Invoices, payments, and anything else stay hands-on in QuickBooks until the estimate path has run clean through real orders.
- **QuickBooks has no "convert" action.** A new document is created and linked to the old one.
- **Every QuickBooks robot answers "OK" even when it fails,** and puts the real error in the message. Otherwise the screen only shows a generic failure.
- **Deleting or voiding needs a fresh version stamp** fetched the moment before, or QuickBooks refuses.
- **Attachments are capped at 20 MB per estimate.** Photos get shrunk before attaching. If a package is still too big, the fallback is a Gmail draft for Tim to approve.
- **Prices are frozen at creation.** A catalog price change never touches an existing estimate or order.

### Robots (Background Jobs)

- **They time out after about a minute.** Each one uses the fast Claude model (Haiku) and does one job. No robot calls another robot.
- **Long jobs run in pages.** The Notion catch-up and the QuickBooks read-back work through a batch at a time.
- **One recording, one transcript.** Phone calls belong in the call log and voice memos in the memo list. The rule that stops duplicates stays in place.
- **Merging to the main branch deploys robots to production at once.** The automatic checks are the only gate, so Phase 0 adds tests on the money paths.

### Vercel And Analytics

- **The free Hobby plan is for personal, non-commercial sites** (https://vercel.com/docs/limits/fair-use-guidelines). A business website needs the Pro plan, listed at $20 a month. This is a spending decision for Chandy.
- **Hobby counts 50,000 visitor events a month** and keeps a short history. The weekly copy into our database removes the history limit.
- **Vercel does not know what a lead is.** Estimate Builder starts, finishes, and form sends are counted by us.

### Claude Duet

- **It is a research preview** (https://www.claude.com/resources/articles/claude-duet). It can change or misjudge what is urgent, so no alarm depends on it.
- **It checks in every few hours.** It is a helper for the day's work and will not catch things the minute they happen.
- **Anthropic has not said whether Duet uses custom connectors.** The actions are built as database functions, so Duet can reach them through the existing database connection if the custom connector is not available.
- **One account each.** Tim needs his own access to message it. Until then he uses the screens and Chandy uses Duet.
- **It cannot see text messages on a phone.** Tim tells it, or forwards a screenshot.
- **Background checks use the same usage allowance** as the rest of the account's Claude work.

### Phone Use For Tim

- **CATL Hub was built desktop-first.** Tim's screens (Leads, Chute Screen, Needs Me Today) are built phone-first: big tap targets, no sideways scrolling, 16-point type in every field so the phone does not zoom.
- **Voice first.** Every action he can tap he can also say to Claude.

### Data

- **The database is behind Notion** until the Phase 3 catch-up.
- **Some units are stale or doubled.** The July review found sold units still showing available and contract 44277 entered twice.
- **Cost and margin are private.** They never appear on the website, in a customer email, or on a shared freight link.

### Email

- **Only verified sender addresses work.** tim@catlresources.com and website@catlresources.com are verified. Any other sender fails instantly.
- **Anything sent to a customer waits for an approval tap.**

## Decisions Only Chandy Can Make

| # | Question | Recommendation | Why |
| --- | --- | --- | --- |
| 1 | Where do the screens live? | CATL Hub at catlapp.com | The working screens are already there. This repo has no hosting and keeps the robots. |
| 2 | What does the inside app look like? | Keep the Hub's dark look inside. Navy, cream, and gold for the website and anything a customer sees. | Restyling six working screens buys nothing for sales. |
| 3 | May the app create estimates in QuickBooks? | Yes, estimates only | It is what removes the retyping. Everything else stays read-only. |
| 4 | Move the website to Vercel Pro at $20 a month? | Yes, before the new site launches | The free plan does not allow business sites. |
| 5 | Which email service sends the weekly tips? | Resend | It is already connected and verified, and it is free until the list passes 1,000 people. |
| 6 | Does each weekly tips email need approval? | Yes for the first month, then automatic | It goes to people outside the business. |
| 7 | Who gets which automatic email? | Monday summary to Chandy and Tim. Daily follow-ups list to Tim. | Tim works the list. Chandy watches the trend. |
| 8 | When is Notion frozen? | The day Chandy approves the catch-up list | Two boards kept by hand is how they drifted apart. |
| 9 | Does Tim get Duet? | Put him on the waitlist now | He has a Claude account, and Duet access is by invitation. |

### Email Service Options

Prices are as found on November 21, 2026. Confirm at signup.

| Service | Free up to | First paid step | Notes |
| --- | --- | --- | --- |
| Resend | 1,000 contacts | $40 a month for 5,000 contacts | Already sends the lead and estimate emails. No new account or sender setup. |
| Kit | 10,000 subscribers | About $39 a month for more features | Largest free plan. A separate system to connect and keep in step. |
| MailerLite | 250 subscribers | About $10 a month | Easy editor. The free plan was cut in 2026. |
| Mailchimp | 250 contacts and 500 emails a month | Varies with list size | The best known and the most expensive as the list grows. |

## Build Prompts

One prompt per phase, run in order, each starting with its TITLE. Claude runs them once Chandy approves the plan.

### Standing Rules For Every Prompt

```text
STANDING RULES (apply to every phase)
- Read first: EQUIPMENT-MANAGER-PLAN.md and project-memory.md in CATL-Resources/catl-order-tracker, and CLAUDE.md in every repo you touch.
- Repos: screens in CATL-Resources/catl-hub (branch master, live at catlapp.com). Robots (Supabase edge functions) and database migrations in CATL-Resources/catl-order-tracker. Public site in CATL-Resources/catl-equipment-website. Database: Supabase project CRLE (dubzwbfqlwhkpmpuejsy).
- Work on a branch, open a pull request with the repo's four headings, merge it yourself when every check is green. Never merge red. Never leave work in a draft.
- Pause and ask only before: destroying production data, sending anything to a person outside the business, or spending money.
- Database changes are additive migration files. Every data write follows rollback copy, guarded write, read-back.
- Frozen snapshot rule: price changes update catalog tables only, never an existing estimate or order.
- QuickBooks: every QuickBooks robot returns HTTP 200 with { success, error }. Fetch a fresh SyncToken immediately before delete or void. No convert endpoints; create a new document with LinkedTxn. The app may create estimates only.
- Robots: Claude Haiku only, one job each, no robot calls another robot, long jobs run in pages.
- Anything automatic stays automatic. No check, report, or reminder may depend on a person running it. Every failure path sends a red alert and is proven by forcing the failure once.
- Tim's screens are phone-first: one-handed, no sideways scrolling, 16px inputs, large tap targets.
- Inside app keeps the CATL Hub look. Customer-facing pages and emails use navy, cream, and gold with the Inter font. Title Case for headings, buttons, and labels. SILENCER is always in capitals.
- Cost and margin never appear on anything public or customer-facing.
- Plain English in every summary. End with what was built, what was proven, and anything Chandy must do.
```

### Phase 0

```text
TITLE: Phase 0 - Repairs And Foundations
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. QuickBooks: add a Reconnect QuickBooks button in CATL Hub that starts the existing qb-auth-start flow. Schedule qb-refresh-token daily with pg_cron. Alert equipment@catlresources.com 14 days before refresh_token_expires_at. Never expose qb_tokens to the browser.
2. Heartbeats: create robot_heartbeats. Every scheduled robot records its last good run. A daily check emails a red BROKEN alert when a robot is quiet past its threshold.
3. Find why call_log stopped on 2026-11-09 and voice_memos on 2026-10-08. Fix, backfill what the source folders still hold, and keep the one-recording-one-transcript guard.
4. Leads intake: confirm the website calls submit_web_lead and submit_contact_lead, then retire the submit-lead edge function if nothing calls it.
5. Analytics: turn on Vercel Web Analytics for catl-equipment-website. Create site_events and site_stats_weekly. Record Estimate Builder start, finish, and form sends with no personal data. Add a weekly job that copies Vercel totals.
6. Remove the Lovable GitHub app, .lovable/, and lovable-tagger from catl-order-tracker.
7. Add tests on the QuickBooks estimate path and the lead intake path.
8. Add a System Health card to the Hub dashboard.
Done when: QuickBooks answers from the app, a robot stopped on purpose produces a red email, yesterday's calls appear, and site_events shows a test Estimate Builder start and finish.
Pause for: Chandy signing in to QuickBooks.
```

### Phase 1

```text
TITLE: Phase 1 - Leads
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. Migration on web_leads: next_follow_up_date, owner, heat (hot, warm, cold), customer_id, qb_estimate_id, qb_estimate_status, lost_reason. Backfill heat from is_hot. Add lead_id to tasks. Create contact_links (contact type, contact id, lead_id, order_id, customer_id, summary, linked_by).
2. A database rule: an open lead must have a next follow-up date.
3. Suggest a lead when a call or voice memo comes from a number that matches no customer. One tap confirms.
4. Hub screens, phone-first: Leads List (filters Due Today, Hot, New, All), Lead Detail (contact info, submitted build, timeline from contact_links, buttons Call, Log Contact, Set Follow-Up, Won, Lost), Add Lead.
5. Scheduled emails: 7 AM follow-ups due to Tim, a flag for any web lead with no contact in 24 hours, and the Monday summary (new leads, due, won, lost, anything broken).
Done when: a test website submission appears within one minute, no open lead lacks a follow-up date, the due list works one-handed on a phone, and the Monday email is proven with a forced run.
```

### Phase 2

```text
TITLE: Phase 2 - Claude Connector, QuickBooks Estimates, Send Package
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. Named actions as database functions with the prefix em_: list due follow-ups, add lead, log contact, set follow-up, lead summary, chute summary, make QuickBooks estimate from a build, make QuickBooks estimate from a description, attach photos to an estimate, send estimate package, refresh QuickBooks status.
2. Make Estimate: map build_json to QuickBooks line items with qb_item_id from base_models and model_options, freeze prices at creation, create the estimate through qb-push-estimate, and save qb_estimate_id on the lead. Retire the in-app estimate builder.
3. Send Package: pick photos from catalog_images and website_photo_picks, shrink to fit 20 MB total, attach to the QuickBooks estimate, and send from QuickBooks only after an approval tap. Fallback: a Gmail draft with the PDF and photos.
4. A robot every 30 minutes reads estimate status and accepted date back into estimates and web_leads. Freeze the copy on acceptance.
5. CATL Equipment connector: a small MCP server (a set of actions Claude can call by name) wrapping the em_ functions, with sign-in. Write the CATL equipment skill as its playbook. Test from Chandy's Duet. If Duet cannot use a custom connector, document the fallback through the existing Supabase connector.
6. Write a ten-minute spoken interview for Tim and store his answers for Phase 3.
7. Hub: Make Estimate button, photo picker, estimate status chip. Monday summary gains estimates sent and accepted.
Done when: an Estimate Builder lead becomes a QuickBooks estimate in under a minute with a matching total, the package arrives as one email, and the same steps work by message.
Pause for: any send to a real customer, and adding the connector to Chandy's Claude account.
```

### Phase 3

```text
TITLE: Phase 3 - The Chute Board
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. Notion catch-up: read the equipment board through the Notion connector, match rows to orders by notion_id and contract number, and produce a difference list for Chandy. Apply only after she approves, with rollback copy and read-back. Resolve the doubled contract 44277 and the stale units with her.
2. Create unit_payments (direction, amount, date, note). Add qb_invoice_balance to orders and refresh it from QuickBooks on the Phase 2 schedule.
3. Start using change_orders. Log changes and modifications by tap or through an em_ action.
4. Keep mfg_contract_number as the one contract identifier and migrate the other two columns into it.
5. Hub screens, phone-first, shaped by Tim's interview: Chute Screen (progress, contract, down payments, paid status, changes, modifications, trucking, paperwork slots) and Needs Me Today.
6. Freeze Notion: mark the board archived and remove it from every workflow doc.
Done when: Tim answers where a chute is and what is left from one screen, paid status matches QuickBooks for ten sampled chutes, and the Monday summary lists chutes by stage.
Pause for: Chandy's approval of the difference list.
```

### Phase 4

```text
TITLE: Phase 4 - Order Truth And The Change Log
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. File every Moly confirmation email to its chute's moly_so slot by contract number, using the existing inbound email robot and Claude Haiku.
2. Compare the accepted QuickBooks estimate to the Moly confirmation option by option through manufacturer_item_mappings. Results: matched, mismatch, known_difference. Rerun on any change to either side.
3. Create change_checks. Every change_orders row opens a checklist scoped to its type (customer spec change, dealer add for inventory, post-factory add). A new Moly confirmation showing the change closes the Moly item automatically.
4. Extend contact_links so calls and emails attach to the chute.
5. Add the two later checks on the same pattern: purchase order against Moly invoice total, and estimate against customer invoice with the margin check.
6. Hub: Order Check panel with Accept Difference and Flag, a Changes tab, a Mismatches list on the dashboard. Add em_ actions for all of it. Monday summary gains open mismatches and open checklists.
Done when: a planted wrong option on a test Moly confirmation is flagged within 30 minutes with nobody opening it, and no change can be saved without its checklist.
```

### Phase 5

```text
TITLE: Phase 5 - Website Management And Analytics
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. Add show_on_website, website_price, and website_blurb to orders, and website_description to base_models and model_options. Create a public_inventory() function that returns only safe fields. Replace src/inventory.json on the website with it.
2. Hub Website tab: Inventory (toggle, price, blurb, photos), Product Text, Photos (move the photo picker in). Prices stay read-only from the catalog.
3. Hub Analytics page: visitors, top pages, sources, phone or computer from site_stats_weekly, plus Estimate Builder starts against finishes, forms sent, and leads to estimates to accepted from our own tables.
4. Monday summary gains the website section with last week against the week before.
5. em_ actions: show or hide a chute on the website, update product text, website numbers for a date range.
Done when: marking a chute Show On Website puts it live within five minutes with no code change, and the Analytics page matches Vercel for one sampled week.
Pause for: nothing, unless Vercel Pro has not been approved before the site launches.
```

### Phase 6

```text
TITLE: Phase 6 - Marketing
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. Create tips and subscribers. Add a signup form and a Tips page to the website in navy, cream, and gold.
2. Weekly send through the email service Chandy chose. Every link carries a tag naming the email and the tip. Log each send in email_log. Include a working unsubscribe link and the business mailing address.
3. Analytics: Email Results section showing which tip and which email brought visits and Estimate Builder starts.
4. Advertising cost: read totals from QuickBooks by the tag Chandy and the CPA choose. Track only; no tax treatment.
5. Hub screens: Tips list and editor, Subscribers. em_ actions: draft a tip, schedule a tip, subscriber count.
6. Monday summary gains subscribers, last send results, and the top tip.
Done when: a tip written Monday is on the site and in Friday's email, and the summary names the tip that brought the most visits.
Pause for: every send to subscribers until Chandy switches it to automatic, and any paid plan.
```

### Phase 7

```text
TITLE: Phase 7 - Freight Finish
Apply the Standing Rules in EQUIPMENT-MANAGER-PLAN.md.
Build:
1. Add the loading stop to freight_run_items and fix the run builder so editing a run keeps each unit's real loading stop.
2. Bill of lading: a printable document per run from freight_runs, stops, items, and the carrier. No cost or margin on it.
3. Carrier rates from carriers.rate_per_loaded_mile and minimum_charge shown as an estimate on the run.
4. Show each chute's freight run on its Chute Screen.
5. em_ actions: build a run, add a stop, where is this chute's truck. Monday summary gains runs this week.
Done when: a run built on a phone produces a bill of lading and appears on each chute's screen.
Pause for: sending a share link or bill of lading to a carrier.
```

## 🔴 YOUR TURN

Nothing is built until item 1. Items 3 to 5 already have a default in the plan.

1. **APPROVE** this plan and the build order, so Claude starts Phase 0.
2. **RUN** the QuickBooks sign-in when Phase 0 hands you the Reconnect button. It takes about two minutes.
3. **DECIDE** where the screens live. Default: CATL Hub at catlapp.com.
4. **DECIDE** the look of the inside app. Default: the Hub's dark look inside, navy, cream, and gold for anything a customer sees.
5. **APPROVE** the app creating estimates in QuickBooks. Default: yes, estimates only.
6. **DECIDE** whether to move the website to Vercel Pro at $20 a month before the new site launches.
7. **DECIDE** the email service for the weekly tips. Recommendation: Resend, free until 1,000 people.
8. **DECIDE** whether each weekly tips email waits for your approval. Recommendation: yes for the first month.
9. **ANSWER** who gets the Monday summary and the daily follow-ups list.
10. **RUN** the Duet waitlist signup for Tim, from his Claude account.
11. **APPROVE** the ten-minute spoken interview with Tim in Phase 2, or answer for him: the three or four things he needs to see first on a chute.
12. **APPROVE** the Notion catch-up list when Phase 3 shows it to you. Notion is frozen that day.
