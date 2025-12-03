# How to Host The Beer Game Yourself on Firebase

This guide shows you how to take the GitHub project:

https://github.com/siemsene/beergame

and host your own copy on Firebase, using the free tier.

You don’t need to know React, TypeScript, or Firebase to follow this. You’ll mostly:

Click buttons in a browser

Copy–paste a few values

Run a handful of commands

# What you’ll end up with

By the end, you’ll have:

Your own Firebase project (your own database & hosting)

Your own Beer Game website at a URL like:

https://your-project-id.web.app

You can then share that URL with students and run sessions independently.

# Prerequisites (before you start)

## A Google account

You need a Google account to use Firebase. If you use Gmail, YouTube, etc., you already have one.

## Node.js and npm

You need Node.js (which includes npm) on your computer.

Go to https://nodejs.org

Download and install the LTS version (“Recommended for most users”).

After installation, open:

Windows: Command Prompt or PowerShell

macOS: Terminal

Linux: your regular terminal

Check that Node and npm work:

node -v
npm -v

If both commands print versions (e.g. v20.x.x, 10.x.x), you’re good.

## Git (recommended but optional)

If you know Git:

git --version

If that prints a version, you’re good.

If you don’t want to use Git, that’s okay — see the “Download ZIP” option below.

# Get the Beer Game code

You need a local copy of the GitHub project on your computer.

## Option A (recommended): Clone with Git

In your terminal:

Go to the folder where you want the project
cd /path/to/your/projects

Clone the repository
git clone https://github.com/siemsene/beergame.git

Go into the new folder
cd beergame

## Option B: Download as ZIP

Visit https://github.com/siemsene/beergame

in your browser.

Click the green Code button → Download ZIP.

Unzip the file.

Open your terminal and cd into the unzipped folder, e.g.:

cd /path/to/Downloads/beergame-main   # adjust to your actual path

From here on, all commands assume you are inside the project folder (beergame or similar).

# Install project dependencies

Inside the project folder:

npm install

This downloads all the JavaScript libraries the app needs.
It might take a few minutes the first time.

# Create your Firebase project

Now we set up Firebase in the browser.

Go to the Firebase console: https://console.firebase.google.com

Click “Add project” (or “Create project”).

Choose a Project name, e.g. beer-game-enno.

Click Continue through the steps.

You can disable Google Analytics if you like (not required).

Click Create project and wait until it’s finished.

You now have an empty Firebase project.

# Set up Firestore (the database)

The Beer Game uses Cloud Firestore to store sessions, players, etc.

In the Firebase console, you can open your project.

On the left, click Build → Firestore Database.

Click Create database.

Choose a location (any region close to you is fine).

For classroom/testing use, you can start in test mode (easier to get started).

Click through to finish creation.

You don’t need to pre-create any collections; the app will create them.

# Add a Web App to get your Firebase config

We need a configuration object so the Beer Game frontend knows how to connect to your Firebase project.

In the Firebase console, go to your project’s Project Overview.

Click the “Web app” icon (</>) to Add app.

Give the app a nickname, e.g. beer-game-web.

You don’t need to set up hosting in this wizard (we’ll use the CLI later), but it’s okay if you do.

After a few steps, Firebase will show a Firebase config object that looks like this:

const firebaseConfig = {
  apiKey: "AIza...something...",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef..."
};

Keep this tab open or copy these values somewhere safe — we’ll use them in the next step.

# Connect the Beer Game code to your Firebase project

The React app reads your Firebase config from a .env file (Vite-style environment variables).

⚠️ Important: Don’t reuse someone else’s keys. Use the config from your own Firebase project.

## Create a .env file

Inside the project folder (same level as package.json), create a file named:

.env

# Add your Firebase config values

Paste this into .env and fill in the values from your Firebase console:

VITE_FIREBASE_API_KEY=your_apiKey_here
VITE_FIREBASE_AUTH_DOMAIN=your_authDomain_here
VITE_FIREBASE_PROJECT_ID=your_projectId_here
VITE_FIREBASE_STORAGE_BUCKET=your_storageBucket_here
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messagingSenderId_here
VITE_FIREBASE_APP_ID=your_appId_here

Match them as follows:

apiKey → VITE_FIREBASE_API_KEY

authDomain → VITE_FIREBASE_AUTH_DOMAIN

projectId → VITE_FIREBASE_PROJECT_ID

storageBucket → VITE_FIREBASE_STORAGE_BUCKET

messagingSenderId → VITE_FIREBASE_MESSAGING_SENDER_ID

appId → VITE_FIREBASE_APP_ID

Save the file.

💡 Security tip: Don’t commit your .env file to a public GitHub repo. It should stay local or in a private repo.

# Install Firebase CLI and log in

The Firebase CLI is a command-line tool to deploy your site.

## Install Firebase CLI

In your terminal:

npm install -g firebase-tools

If you get a permission error on macOS/Linux, try:

sudo npm install -g firebase-tools

Check that it installed correctly:

firebase --version

## Log in to Firebase

firebase login

A browser window will open. Log in with your Google account and allow access, then return to the terminal.

# Initialize Firebase Hosting for this project

Now we connect this local folder to your Firebase project and configure Hosting.

Make sure you are inside your project folder:

cd /path/to/beergame   # if you're not already there

Run:

firebase init hosting

The CLI will ask a few questions. Recommended answers:

Which Firebase features do you want to set up for this directory?

Select:
Hosting: Configure files for Firebase Hosting
(Use Space to select, Enter to confirm.)

Please select an option:

Choose: Use an existing project

Then pick the project you created earlier (e.g. beer-game-enno).

What do you want to use as your public directory?

Type:

dist

This is where Vite will put the production build.

Configure as a single-page app (rewrite all URLs to /index.html)?

Type y (yes). This is standard for React/Vite apps.

Set up automatic builds and deploys with GitHub?

For now, type n (no). You can add this later if you want CI/CD.

This will create or update:

firebase.json – tells Firebase what to deploy and from where.

.firebaserc – remembers which Firebase project this folder is linked to.

If it asks to overwrite an existing firebase.json or .firebaserc, choose Yes so it matches your project.

# Build the app for production

The Beer Game uses Vite to build the production files.

In the project folder, run:

npm run build


This creates a dist folder containing the static files that Firebase will host.

Optional: You can test the production build locally:

npm run preview


Then open the printed URL (usually http://localhost:4173) in your browser.

# Deploy to Firebase Hosting 🚀

Now deploy the dist folder to Firebase:

firebase deploy --only hosting


When it’s done, the CLI will print something like:

Hosting URL: https://your-project-id.web.app


Open that URL in your browser — that’s your Beer Game instance.

# Using your hosted Beer Game

From here, usage is just like the original:

Visit your URL, e.g. https://your-project-id.web.app.

Log in as host (password: Sesame, unless you changed it in the code).

Create a session ID.

Share the URL + session ID with students.

They join with that session ID and a name.

Start the game, then debrief afterwards.

All data is stored in your Firestore database.

# How to update / redeploy later

If you pull new changes from GitHub or modify the code yourself:

In the project folder, run:

npm install        # only if dependencies changed
npm run build
firebase deploy --only hosting


Your URL (e.g. https://your-project-id.web.app) will now show the updated version.

# Common issues & quick fixes
“firebase: command not found”

Firebase CLI isn’t installed or isn’t on your PATH.

Re-run:

npm install -g firebase-tools

“node: command not found”

Node.js isn’t installed or your terminal doesn’t know where it is.

Reinstall Node.js from https://nodejs.org
 and restart your terminal.

Blank page or errors in the browser

Check .env — your VITE_FIREBASE_* values must exactly match the firebaseConfig from your Firebase console.

Confirm that Firestore is enabled in the Firebase console (Build → Firestore Database).

Deploy succeeds but changes don’t show up

Make sure you ran npm run build before firebase deploy.

Try a hard refresh in the browser:

Windows: Ctrl + F5

macOS: Cmd + Shift + R

# Summary (super short version)

## One-time setup

git clone https://github.com/siemsene/beergame.git
cd beergame
npm install

## In Firebase console:
- Create project
- Create Firestore database
- Add web app and copy firebaseConfig
- Create .env with VITE_FIREBASE_* variables

firebase login
firebase init hosting   # existing project, public = dist, SPA = yes

## Build & deploy

npm run build
firebase deploy --only hosting


You now have a fully hosted, classroom-ready Beer Game instance on Firebase. 🍻
