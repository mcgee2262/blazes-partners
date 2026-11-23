# Blaze's Partners — setup for Dad (about 10 minutes)

The dashboard already works in **demo mode** (data saved on one device). These steps make it
**one shared dashboard** for both of us, updating live on both phones.

## 1. Make the Supabase project
1. Go to supabase.com, sign up (free plan is fine), click **New project**.
2. Name: `blazes-partners`. Pick a strong database password and save it in your password manager.
   Region: East US. Wait about 2 minutes for it to start.

## 2. Make the tables
1. Left menu -> **SQL Editor** -> **New query**.
2. Open `supabase/schema.sql`, change the two example emails at the bottom to our real login emails
   (lowercase), paste the whole thing in, and click **Run**. It should say "Success".

## 3. Make our two logins
1. Left menu -> **Authentication** -> **Users** -> **Add user** -> **Create new user**.
2. Add your email + a password. Tick **Auto Confirm User**. Do the same for Blaise's email
   (Blaise types his own password).
3. Optional but smart: Authentication -> Sign In / Providers -> turn **off** "Allow new users to sign up",
   so nobody else can make an account.

## 4. Connect the app
1. Left menu -> **Project Settings** -> **API** (or "Data API").
2. Copy the **Project URL** and the **anon / publishable key**.
   (Never use the `service_role` / secret key — that one stays private.)
3. Paste both into `config.js`. That's it: the app now asks for email + password.
   (For a quick test you can instead paste them on the app's **More** tab -> Connect.)

## 5. Move the demo data over (optional)
Sign in on the device that has the demo data -> **More** -> "Copy this device's demo data up".

## Money rules
The rule numbers (salary %, monthly cap, working capital, ownership %) are NOT in the code —
this repo is public. Enter them once on the app's **More** tab; they're saved in Supabase with everything else.
