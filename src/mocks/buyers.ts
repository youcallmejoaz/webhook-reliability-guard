import type { Buyer } from '../types.js';

// 50 fictional buyers. Addresses are built at runtime on the reserved example.com domain.
const FIRST = [
  'Ada', 'Bayo', 'Chloe', 'Dami', 'Elena', 'Femi', 'Grace', 'Hassan', 'Ifeoma', 'Jonah',
  'Kemi', 'Liam', 'Maya', 'Nnamdi', 'Olivia', 'Priya', 'Quinn', 'Rosa', 'Samuel', 'Tara',
  'Uche', 'Victor', 'Wanjiru', 'Xavier', 'Yetunde', 'Zara', 'Amara', 'Ben', 'Chidi', 'Daniela',
  'Ethan', 'Fatima', 'Gabriel', 'Hana', 'Isaac', 'Joy', 'Kofi', 'Lena', 'Musa', 'Nora',
  'Obi', 'Paula', 'Rahim', 'Sade', 'Tomas', 'Uma', 'Vera', 'Wale', 'Yusuf', 'Zoe',
];
const LAST = [
  'Okafor', 'Adeyemi', 'Martin', 'Bello', 'Rossi', 'Ojo', 'Kim', 'Ali', 'Eze', 'Clarke',
  'Balogun', 'Murphy', 'Patel', 'Obi', 'Brown', 'Shah', 'Taylor', 'Garcia', 'Mensah', 'Lee',
  'Nwosu', 'Silva', 'Kamau', 'Dubois', 'Afolabi', 'Haddad', 'Udeh', 'Walker', 'Okeke', 'Lopez',
  'Hughes', 'Yusuf', 'Moreau', 'Sato', 'Cohen', 'Ibe', 'Asante', 'Novak', 'Danjuma', 'Berg',
  'Chukwu', 'Ferreira', 'Karim', 'Ogun', 'Weber', 'Rao', 'Ivanova', 'Adebayo', 'Hassan', 'Fischer',
];
export const PRODUCTS = ['Starter Course', 'Pro Membership', 'Coaching Bundle'];

export function demoBuyers(count = 50): Buyer[] {
  return Array.from({ length: count }, (_, i) => {
    const first = FIRST[i % FIRST.length];
    const last = LAST[i % LAST.length];
    return {
      id: `cus_${String(1001 + i)}`,
      first_name: first,
      last_name: last,
      email: `${first}.${last}${i + 1}`.toLowerCase() + '@example.com',
    };
  });
}

// A few buyers typed their address wrong at checkout, so the mock sender bounces them.
export function bounces(buyer: Buyer): boolean {
  return ['cus_1013', 'cus_1037'].includes(buyer.id);
}
