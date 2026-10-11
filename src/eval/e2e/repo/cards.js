import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2022-08-01" });

export async function getCardDetails(cardId) {
  return stripe.issuing.cards.retrieveDetails(cardId);
}

export async function freezeCard(cardId) {
  return stripe.issuing.cards.update(cardId, { status: "inactive" });
}
