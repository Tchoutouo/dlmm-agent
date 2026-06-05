import { TradeJournal } from "./journal/journal.js";
import { analyzeJournal, formatReport } from "./learning/learningAgent.js";

/**
 * Lance l'agent d'apprentissage sur l'historique du journal et affiche le
 * rapport (performances, erreurs récurrentes, calibration, suggestions).
 */
function main() {
  const journal = new TradeJournal();
  const entries = journal.allEntries();
  if (entries.length === 0) {
    console.log("Journal vide — lance d'abord `npm run scan` pour générer des décisions.");
    journal.close();
    return;
  }
  const report = analyzeJournal(entries);
  console.log(formatReport(report));
  journal.close();
}

main();
