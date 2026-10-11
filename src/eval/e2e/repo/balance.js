import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-08-01" });

export async function available() {
  const balance = await stripe.balance.retrieve();
  return balance.available.map((b) => `${b.amount} ${b.currency}`);
}
