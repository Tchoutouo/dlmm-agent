/**
 * Verrou « un seul job à la fois » pour le démon.
 *
 * Les tâches du démon (marquage, scan, clôtures demandées) signent toutes avec
 * le même wallet et modifient le même suivi : deux exécutions simultanées
 * pourraient fermer deux fois une position ou fausser la comptabilité. Un job
 * qui arrive pendant qu'un autre tourne est ignoré (il repassera au tick
 * suivant) plutôt que mis en file : une file pourrait s'allonger sans fin si
 * un job ralentit.
 */
export class JobLock {
  private running: string | null = null;

  /** Exécute `job` si rien d'autre ne tourne ; renvoie false s'il a été ignoré. */
  async runExclusive(name: string, job: () => Promise<void>): Promise<boolean> {
    if (this.running) {
      console.log(`  ⏭️  ${name} ignoré : « ${this.running} » encore en cours`);
      return false;
    }
    this.running = name;
    try {
      await job();
      return true;
    } finally {
      this.running = null;
    }
  }

  get busy(): string | null {
    return this.running;
  }
}
