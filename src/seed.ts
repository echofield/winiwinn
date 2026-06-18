/**
 * seed.ts — `npm run seed` builds a demo chain so /convert is demoable instantly:
 *
 *   Alice --recommends--> Bob --recommends--> Carol
 *   Carol publishes a recommendation ("Dinner at Septime", €100).
 *
 * When that recommendation converts, the domino walks UP from Carol:
 *   Carol (payee, hop0) | Bob (hop1) | Alice (hop2).
 */
import 'dotenv/config';
import { createUser, createEdge, createRecommendation, Dna } from './db';
import { createCustomer } from './mollie';
import { randomBytes } from 'crypto';

const dna = (vector: number[], color: string): Dna => ({ vector, color });

async function main() {
  const alice = createUser('Alice', dna([0.9, 0.2, 0.5, 0.1], '#E4572E'), await createCustomer('Alice'));
  const bob = createUser('Bob', dna([0.3, 0.8, 0.4, 0.6], '#17BEBB'), await createCustomer('Bob'));
  const carol = createUser('Carol', dna([0.5, 0.5, 0.9, 0.3], '#FFC914'), await createCustomer('Carol'));

  createEdge(alice.id, bob.id); // Alice recommended Bob
  createEdge(bob.id, carol.id); // Bob recommended Carol

  const tok = randomBytes(6).toString('hex');
  const rec = createRecommendation(tok, carol.id, 'Dinner at Septime', 10000); // €100.00

  console.log('\nSeeded demo chain:');
  console.log(`  Alice  ${alice.id}`);
  console.log(`  Bob    ${bob.id}`);
  console.log(`  Carol  ${carol.id}`);
  console.log(`\n  Recommendation "${rec.title}" (€100.00) by Carol`);
  console.log(`  token: ${tok}`);
  console.log(`\nDemo it:`);
  console.log(`  curl -X POST http://localhost:8080/convert -H "Content-Type: application/json" -d '{"token":"${tok}","payerUserId":"${alice.id}"}'`);
  console.log(`  curl -X POST http://localhost:8080/webhooks/mollie -H "Content-Type: application/json" -d '{"token":"${tok}","amountCents":10000}'`);
  console.log(`  curl http://localhost:8080/users/${carol.id}/ledger\n`);
}

main().then(() => process.exit(0));
