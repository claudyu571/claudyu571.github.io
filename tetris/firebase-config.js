const firebaseConfig = {
  apiKey: "AIzaSyDJnSTcMqfDlU8kRDtqx-7jJDpWZ8Zww1c",
  authDomain: "snake-game-f7d4a.firebaseapp.com",
  projectId: "snake-game-f7d4a",
  storageBucket: "snake-game-f7d4a.firebasestorage.app",
  messagingSenderId: "885747541702",
  appId: "1:885747541702:web:88ce36d84740cb1adcd9c7",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
