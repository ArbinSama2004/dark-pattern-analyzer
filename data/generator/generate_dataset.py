#!/usr/bin/env python3
"""
Synthetic multilingual dark-pattern dataset generator (en / hi / ne).

Design goals:
  1. Multi-LABEL (not multi-class): one string can be scarcity + false_urgency.
  2. Includes a large BENIGN class with HARD NEGATIVES (e.g. "In stock",
     "1,204 reviews", "Create account") that sit right next to positives.
  3. Every row carries a template_id so you can build a TEMPLATE-DISJOINT
     split. That is the only honest way to evaluate templated synthetic data:
     the test set contains phrasings the model has never seen.
  4. Emits a `model_input` column with DOM context tokens prepended.

Run:  python3 generate_dataset.py
"""

import csv
import json
import os
import random
import re
from collections import Counter, defaultdict

SEED = 13
OUTDIR = "/data/dp_dataset"
N_PER_DARK_PER_LANG = 1000
N_BENIGN_PER_LANG = 2000

LABELS = [
    "confirmshaming",
    "false_urgency",
    "forced_action",
    "obstruction",
    "scarcity",
    "sneaking",
    "social_proof",
    "benign",
]
DARK_LABELS = [l for l in LABELS if l != "benign"]
LANGS = ["en", "hi", "ne"]

# --------------------------------------------------------------------------
# Slot vocabularies
# --------------------------------------------------------------------------
SLOTS = {
    "en": {
        "PRODUCT": [
            "running shoes", "wireless earbuds", "cotton kurta", "laptop bag",
            "smartwatch", "face wash", "office chair", "power bank",
            "trekking jacket", "yoga mat", "coffee maker", "school bag",
            "bluetooth speaker", "denim jeans", "air fryer", "study lamp",
            "sports sandals", "hair dryer", "gaming mouse", "water bottle",
            "winter blanket", "rice cooker", "sunglasses", "phone case",
            "protein powder", "electric kettle", "formal shirt", "backpack",
            "induction cooktop", "noise cancelling headphones",
        ],
        "CITY": [
            "Kathmandu", "Pokhara", "Lalitpur", "Biratnagar", "Bhaktapur",
            "Delhi", "Mumbai", "Pune", "Jaipur", "Patna", "Butwal",
            "Chitwan", "Dharan", "Nepalgunj", "Lucknow", "Indore",
            "Hyderabad", "Kolkata", "Surat", "Bengaluru",
        ],
        "NAME": [
            "Aarav", "Sita", "Rohan", "Priya", "Bikash", "Anita", "Kiran",
            "Nisha", "Suman", "Rekha", "Manish", "Pooja", "Sagar", "Deepa",
            "Ramesh", "Sneha", "Arjun", "Kavya", "Nabin", "Jyoti",
            "Prakash", "Meera", "Sanjay", "Laxmi", "Dipesh",
        ],
        "TIME": [
            "00:59", "02:14", "04:30", "09:45", "12:00", "14:59", "19:20",
            "23:11", "1 minute", "3 minutes", "5 minutes", "7 minutes",
            "10 minutes", "15 minutes", "20 minutes", "30 minutes",
            "45 minutes", "1 hour", "2 hours", "3 hours", "6 hours",
            "12 hours", "18 hours", "24 hours", "48 hours",
        ],
        "HOURS": ["2", "3", "4", "6", "8", "12", "24", "48"],
        "NUM_SMALL": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "12"],
        "NUM_BIG": [
            "27", "48", "63", "84", "112", "149", "186", "203", "247",
            "288", "312", "367", "402", "455", "512", "578", "634", "701",
            "766", "812", "889", "934", "1,024", "1,187", "1,340", "1,502",
            "1,765", "2,038", "2,411", "3,109", "4,265", "5,872",
            "7,340", "9,118", "11,204", "14,860", "18,332", "21,507",
            "26,940", "34,118",
        ],
        "PERCENT": ["5", "10", "15", "20", "25", "30", "35", "40", "50", "60", "70", "80"],
        "PRICE": [
            "49", "99", "149", "199", "249", "299", "349", "399", "449",
            "499", "599", "699", "799", "899", "999", "1,199", "1,499",
            "1,999", "2,499", "2,999",
        ],
        "PLAN": ["Premium", "Plus", "Pro", "Gold", "Prime"],
        "DAYS": ["2", "3", "4", "5", "7", "10", "14"],
    },
    "hi": {
        "PRODUCT": [
            "रनिंग शूज़", "वायरलेस ईयरबड्स", "कॉटन कुर्ता", "लैपटॉप बैग",
            "स्मार्टवॉच", "फेस वॉश", "ऑफिस चेयर", "पावर बैंक",
            "ट्रेकिंग जैकेट", "योगा मैट", "कॉफी मेकर", "स्कूल बैग",
            "ब्लूटूथ स्पीकर", "डेनिम जींस", "एयर फ्रायर", "स्टडी लैंप",
            "स्पोर्ट्स सैंडल", "हेयर ड्रायर", "गेमिंग माउस", "पानी की बोतल",
            "सर्दी का कंबल", "राइस कुकर", "धूप का चश्मा", "फोन कवर",
            "प्रोटीन पाउडर", "इलेक्ट्रिक केटल", "फॉर्मल शर्ट", "बैकपैक",
            "इंडक्शन चूल्हा", "नॉइज़ कैंसलिंग हेडफोन",
        ],
        "CITY": [
            "दिल्ली", "मुंबई", "पुणे", "जयपुर", "पटना", "लखनऊ", "इंदौर",
            "हैदराबाद", "कोलकाता", "सूरत", "बेंगलुरु", "भोपाल", "नागपुर",
            "कानपुर", "रांची", "अहमदाबाद", "चंडीगढ़", "वाराणसी", "आगरा", "नासिक",
        ],
        "NAME": [
            "आरव", "सीता", "रोहन", "प्रिया", "विकास", "अनीता", "किरण",
            "निशा", "सुमन", "रेखा", "मनीष", "पूजा", "सागर", "दीपा",
            "रमेश", "स्नेहा", "अर्जुन", "काव्या", "नवीन", "ज्योति",
            "प्रकाश", "मीरा", "संजय", "लक्ष्मी", "दीपेश",
        ],
        "TIME": [
            "00:59", "02:14", "04:30", "09:45", "12:00", "14:59", "19:20",
            "23:11", "1 मिनट", "3 मिनट", "5 मिनट", "7 मिनट", "10 मिनट",
            "15 मिनट", "20 मिनट", "30 मिनट", "45 मिनट", "1 घंटे",
            "2 घंटे", "3 घंटे", "6 घंटे", "12 घंटे", "18 घंटे",
            "24 घंटे", "48 घंटे",
        ],
        "HOURS": ["2", "3", "4", "6", "8", "12", "24", "48"],
        "NUM_SMALL": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "12"],
        "NUM_BIG": [
            "27", "48", "63", "84", "112", "149", "186", "203", "247",
            "288", "312", "367", "402", "455", "512", "578", "634", "701",
            "766", "812", "889", "934", "1,024", "1,187", "1,340", "1,502",
            "1,765", "2,038", "2,411", "3,109", "4,265", "5,872",
            "7,340", "9,118", "11,204", "14,860", "18,332", "21,507",
            "26,940", "34,118",
        ],
        "PERCENT": ["5", "10", "15", "20", "25", "30", "35", "40", "50", "60", "70", "80"],
        "PRICE": [
            "49", "99", "149", "199", "249", "299", "349", "399", "449",
            "499", "599", "699", "799", "899", "999", "1,199", "1,499",
            "1,999", "2,499", "2,999",
        ],
        "PLAN": ["प्रीमियम", "प्लस", "प्रो", "गोल्ड", "प्राइम"],
        "DAYS": ["2", "3", "4", "5", "7", "10", "14"],
    },
    "ne": {
        "PRODUCT": [
            "रनिङ जुत्ता", "वायरलेस इयरबड्स", "कटन कुर्ता", "ल्यापटप ब्याग",
            "स्मार्टवाच", "फेस वास", "अफिस कुर्सी", "पावर ब्यांक",
            "ट्रेकिङ ज्याकेट", "योगा म्याट", "कफी मेकर", "स्कुल ब्याग",
            "ब्लुटुथ स्पिकर", "डेनिम जिन्स", "एयर फ्रायर", "स्टडी लाइट",
            "स्पोर्ट्स चप्पल", "हेयर ड्रायर", "गेमिङ माउस", "पानीको बोतल",
            "हिउँदको ब्ल्याङ्केट", "राइस कुकर", "घामको चस्मा", "फोन कभर",
            "प्रोटिन पाउडर", "इलेक्ट्रिक केतली", "फर्मल सर्ट", "ब्याकप्याक",
            "इन्डक्सन चुल्हो", "नोइज क्यान्सलिङ हेडफोन",
        ],
        "CITY": [
            "काठमाडौँ", "पोखरा", "ललितपुर", "विराटनगर", "भक्तपुर", "बुटवल",
            "चितवन", "धरान", "नेपालगन्ज", "वीरगन्ज", "हेटौंडा", "जनकपुर",
            "धनगढी", "इटहरी", "दमक", "बाँके", "सुर्खेत", "गोरखा", "बागलुङ", "तनहुँ",
        ],
        "NAME": [
            "आरव", "सीता", "रोहन", "प्रिया", "विकास", "अनिता", "किरण",
            "निशा", "सुमन", "रेखा", "मनिष", "पूजा", "सागर", "दीपा",
            "रमेश", "स्नेहा", "अर्जुन", "काव्या", "नवीन", "ज्योति",
            "प्रकाश", "मीरा", "सञ्जय", "लक्ष्मी", "दीपेश",
        ],
        "TIME": [
            "00:59", "02:14", "04:30", "09:45", "12:00", "14:59", "19:20",
            "23:11", "1 मिनेट", "3 मिनेट", "5 मिनेट", "7 मिनेट", "10 मिनेट",
            "15 मिनेट", "20 मिनेट", "30 मिनेट", "45 मिनेट", "1 घण्टा",
            "2 घण्टा", "3 घण्टा", "6 घण्टा", "12 घण्टा", "18 घण्टा",
            "24 घण्टा", "48 घण्टा",
        ],
        "HOURS": ["2", "3", "4", "6", "8", "12", "24", "48"],
        "NUM_SMALL": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "12"],
        "NUM_BIG": [
            "27", "48", "63", "84", "112", "149", "186", "203", "247",
            "288", "312", "367", "402", "455", "512", "578", "634", "701",
            "766", "812", "889", "934", "1,024", "1,187", "1,340", "1,502",
            "1,765", "2,038", "2,411", "3,109", "4,265", "5,872",
            "7,340", "9,118", "11,204", "14,860", "18,332", "21,507",
            "26,940", "34,118",
        ],
        "PERCENT": ["5", "10", "15", "20", "25", "30", "35", "40", "50", "60", "70", "80"],
        "PRICE": [
            "49", "99", "149", "199", "249", "299", "349", "399", "449",
            "499", "599", "699", "799", "899", "999", "1,199", "1,499",
            "1,999", "2,499", "2,999",
        ],
        "PLAN": ["प्रिमियम", "प्लस", "प्रो", "गोल्ड", "प्राइम"],
        "DAYS": ["2", "3", "4", "5", "7", "10", "14"],
    },
}

# --------------------------------------------------------------------------
# Templates.  "||label" suffix marks an additional (multi-label) tag.
# --------------------------------------------------------------------------
TEMPLATES = {
    "confirmshaming": {
        "en": [
            "No thanks, I don't want to save {PERCENT}%",
            "I'd rather pay full price for {PRODUCT}",
            "No thanks, I like wasting money",
            "I don't want exclusive deals on {PRODUCT}",
            "Skip — I'm not interested in saving on {PRODUCT}",
            "No, I'd rather miss out on {PERCENT}% off",
            "I hate discounts, close this",
            "Maybe later, I enjoy overpaying for {PRODUCT}",
            "No thanks, my {PRODUCT} can wait",
            "I don't care about saving Rs. {PRICE}",
            "No, I don't want free shipping on {PRODUCT}",
            "Continue without protecting my order",
            "I'll risk it and pay Rs. {PRICE} more later",
            "No thanks, I'm happy with a bad deal",
            "Close — I don't need {PERCENT}% off {PRODUCT}",
            "I don't want to be smart with money",
            "No thanks, I don't like {PRODUCT} anyway",
            "I'm fine paying Rs. {PRICE} extra",
        ],
        "hi": [
            "नहीं, मुझे {PERCENT}% बचत नहीं चाहिए",
            "मुझे {PRODUCT} का पूरा दाम देना पसंद है",
            "नहीं धन्यवाद, मुझे छूट पसंद नहीं",
            "मुझे {PRODUCT} पर खास ऑफ़र नहीं चाहिए",
            "छोड़ें — मुझे {PRODUCT} पर बचत नहीं चाहिए",
            "नहीं, {PERCENT}% छूट का मौका छोड़ दें",
            "मुझे रु. {PRICE} की बचत की परवाह नहीं",
            "बाद में देखेंगे, ज़्यादा दाम देना ठी�� है",
            "नहीं, मुझे {PRODUCT} पर मुफ़्त डिलीवरी नहीं चाहिए",
            "ऑर्डर सुरक्षा के बिना जारी रखें",
            "बंद करें — मुझे {PERCENT}% छूट नहीं चाहिए",
            "मुझे समझदारी से खरीदारी नहीं करनी",
            "नहीं धन्यवाद, मुझे बुरा सौदा ही चाहिए",
            "रु. {PRICE} ज़्यादा देना मुझे ठीक लगता है",
            "नहीं, मुझे {PRODUCT} पसंद नहीं",
            "मुझे पैसे बचाने में रुचि नहीं",
        ],
        "ne": [
            "पर्दैन, मलाई {PERCENT}% बचत चाहिँदैन",
            "मलाई {PRODUCT} को पूरा मूल्य तिर्न मन पर्छ",
            "धन्यवाद, मलाई छुट मन पर्दैन",
            "मलाई {PRODUCT} मा विशेष अफर चाहिँदैन",
            "छोड्नुहोस् — मलाई {PRODUCT} मा बचत चाहिँदैन",
            "पर्दैन, {PERCENT}% छुटको मौका छाडिदिनुहोस्",
            "मलाई रु. {PRICE} बचतको मतलब छैन",
            "पछि हेरौंला, बढी तिर्न ठीकै छ",
            "पर्दैन, मलाई {PRODUCT} मा निःशुल्क ढुवानी चाहिँदैन",
            "अर्डर सुरक्षा बिना जारी राख्नुहोस्",
            "बन्द गर्नुहोस् — मलाई {PERCENT}% छुट चाहिँदैन",
            "मलाई किफायती किनमेल गर्नु छैन",
            "धन्यवाद, नराम्रो सौदा भए पनि हुन्छ",
            "रु. {PRICE} बढी तिर्न मलाई ठीकै छ",
            "पर्दैन, मलाई {PRODUCT} मन पर्दैन",
            "मलाई पैसा बचाउनमा रुचि छैन",
        ],
    },
    "false_urgency": {
        "en": [
            "Sale ends in {TIME}!",
            "Hurry! Offer on {PRODUCT} expires in {TIME}",
            "Deal of the day ends in {TIME}",
            "Your cart will expire in {TIME}",
            "Prices go up in {TIME}",
            "Last chance — {TIME} left on {PRODUCT}",
            "Flash sale ending in {TIME}, don't miss out",
            "Offer valid for the next {NUM_SMALL} minutes only",
            "Countdown: {TIME} until the price rises",
            "Book within {TIME} to lock this rate",
            "Today only! {PERCENT}% off {PRODUCT}",
            "Only {TIME} remaining on this deal",
            "Reserved for you for {TIME}",
            "Extended by popular demand — final {HOURS} hours",
            "Offer ends in {TIME} — only {NUM_SMALL} left!||scarcity",
            "{PERCENT}% off expires in {TIME}",
            "Order in {TIME} to get delivery in {DAYS} days",
        ],
        "hi": [
            "सेल {TIME} में खत्म!",
            "जल्दी करें! {PRODUCT} पर ऑफ़र {TIME} में समाप्त",
            "आज का सौदा {TIME} में खत्म",
            "आपका कार्ट {TIME} में खाली हो जाएगा",
            "दाम {TIME} में बढ़ जाएंगे",
            "आख़िरी मौका — {PRODUCT} पर {TIME} बाकी",
            "फ्लैश सेल {TIME} में खत्म, चूकें नहीं",
            "अगले {NUM_SMALL} मिनट तक ही मान्य",
            "काउंटडाउन: {TIME} में कीमत बढ़ेगी",
            "यह दर पाने के लिए {TIME} में बुक करें",
            "सिर्फ़ आज! {PRODUCT} पर {PERCENT}% छूट",
            "इस डील पर केवल {TIME} शेष",
            "यह कीमत आपके लिए {TIME} तक सुरक्षित",
            "मांग के कारण {HOURS} घंटे बढ़ाया गया",
            "ऑफ़र {TIME} में खत्म — केवल {NUM_SMALL} बचे!||scarcity",
            "{PERCENT}% छूट {TIME} में समाप्त",
            "{TIME} में ऑर्डर करें, {DAYS} दिन में डिलीवरी",
        ],
        "ne": [
            "सेल {TIME} मा सकिन्छ!",
            "छिटो गर्नुहोस्! {PRODUCT} को अफर {TIME} मा सकिँदै",
            "आजको डिल {TIME} मा सकिन्छ",
            "तपाईंको कार्ट {TIME} मा खाली हुनेछ",
            "मूल्य {TIME} मा बढ्नेछ",
            "अन्तिम मौका — {PRODUCT} मा {TIME} बाँकी",
            "फ्ल्यास सेल {TIME} मा सकिँदै, नगुमाउनुहोस्",
            "अर्को {NUM_SMALL} मिनेटसम्म मात्र मान्य",
            "काउन्टडाउन: {TIME} मा मूल्य बढ्नेछ",
            "यो दर पाउन {TIME} भित्र बुक गर्नुहोस्",
            "आज मात्र! {PRODUCT} मा {PERCENT}% छुट",
            "यो डिलमा {TIME} मात्र बाँकी",
            "यो मूल्य तपाईंका लागि {TIME} सम्म सुरक्षित",
            "मागका कारण {HOURS} घण्टा थपियो",
            "अफर {TIME} मा सकिन्छ — {NUM_SMALL} मात्र बाँकी!||scarcity",
            "{PERCENT}% छुट {TIME} मा सकिन्छ",
            "{TIME} भित्र अर्डर गर्नुहोस्, {DAYS} दिनमा डेलिभरी",
        ],
    },
    "scarcity": {
        "en": [
            "Only {NUM_SMALL} left in stock!",
            "Only {NUM_SMALL} {PRODUCT} remaining at this price",
            "Almost sold out — {PERCENT}% already claimed",
            "Low stock: only {NUM_SMALL} units of {PRODUCT}",
            "Last {NUM_SMALL} pieces available",
            "Only {NUM_SMALL} rooms left in {CITY}",
            "High demand — limited units of {PRODUCT}",
            "{NUM_BIG} people bought this today, stock running out||social_proof",
            "Selling fast, {NUM_SMALL} left",
            "Limited edition {PRODUCT} — while supplies last",
            "Only {NUM_SMALL} left at Rs. {PRICE}",
            "In {NUM_SMALL} carts right now",
            "Only {NUM_SMALL} left — {PERCENT}% off ends soon||false_urgency",
            "Hurry, {NUM_SMALL} {PRODUCT} left in {CITY} warehouse",
            "Stock alert: fewer than {NUM_SMALL} remaining",
        ],
        "hi": [
            "स्टॉक में केवल {NUM_SMALL} बचे!",
            "इस दाम पर केवल {NUM_SMALL} {PRODUCT} उपलब्ध",
            "लगभग बिक चुका — {PERCENT}% बुक हो गया",
            "कम स्टॉक: {PRODUCT} की केवल {NUM_SMALL} इकाई",
            "आख़िरी {NUM_SMALL} पीस उपलब्ध",
            "{CITY} में केवल {NUM_SMALL} कमरे बचे",
            "भारी मांग — {PRODUCT} की सीमित मात्रा",
            "आज {NUM_BIG} लोगों ने खरीदा, स्टॉक कम||social_proof",
            "तेजी से बिक रहा है, {NUM_SMALL} बचे",
            "सीमित संस्करण {PRODUCT} — जब तक स्टॉक",
            "रु. {PRICE} पर केवल {NUM_SMALL} बचे",
            "अभी {NUM_SMALL} कार्ट में है",
            "केवल {NUM_SMALL} बचे — {PERCENT}% छूट जल्द खत्म||false_urgency",
            "जल्दी करें, {CITY} गोदाम में {NUM_SMALL} {PRODUCT} बचे",
            "स्टॉक अलर्ट: {NUM_SMALL} से कम बचे",
        ],
        "ne": [
            "स्टकमा {NUM_SMALL} मात्र बाँकी!",
            "यो मूल्यमा {NUM_SMALL} {PRODUCT} मात्र उपलब्ध",
            "प्रायः सकियो — {PERCENT}% बुक भइसक्यो",
            "कम स्टक: {PRODUCT} को {NUM_SMALL} थान मात्र",
            "अन्तिम {NUM_SMALL} थान उपलब्ध",
            "{CITY} मा {NUM_SMALL} कोठा मात्र बाँकी",
            "उच्च माग — {PRODUCT} को सीमित परिमाण",
            "आज {NUM_BIG} जनाले किन्नुभयो, स्टक सकिँदै||social_proof",
            "छिटो बिक्री हुँदैछ, {NUM_SMALL} बाँकी",
            "सीमित संस्करण {PRODUCT} — स्टक रहेसम्म",
            "रु. {PRICE} मा {NUM_SMALL} मात्र बाँकी",
            "अहिले {NUM_SMALL} कार्टमा छ",
            "{NUM_SMALL} मात्र बाँकी — {PERCENT}% छुट चाँडै सकिन्छ||false_urgency",
            "छिटो गर्नुहोस्, {CITY} गोदाममा {NUM_SMALL} {PRODUCT} बाँकी",
            "स्टक अलर्ट: {NUM_SMALL} भन्दा कम बाँकी",
        ],
    },
    "social_proof": {
        "en": [
            "{NUM_BIG} people are viewing this right now",
            "{NAME} from {CITY} just bought this",
            "{NUM_BIG} bought {PRODUCT} in the last {HOURS} hours",
            "Trending #1 in {PRODUCT}",
            "{NUM_BIG} customers added {PRODUCT} to cart today",
            "Rated by {NUM_BIG} verified buyers in {CITY}",
            "{NAME} and {NUM_BIG} others recommend {PRODUCT}",
            "Most loved {PRODUCT} by shoppers in {CITY}",
            "{NUM_BIG} reviews — join them",
            "Someone in {CITY} purchased {PRODUCT} minutes ago",
            "Bestseller — {NUM_BIG} sold this week",
            "{NUM_BIG} shoppers from {CITY} chose {PRODUCT}",
            "{NAME} just saved Rs. {PRICE} on this",
            "{NUM_BIG} people have this in their wishlist",
            "{NUM_BIG} viewing — only {NUM_SMALL} left||scarcity",
        ],
        "hi": [
            "{NUM_BIG} लोग अभी यह देख रहे हैं",
            "{CITY} से {NAME} ने अभी यह खरीदा",
            "पिछले {HOURS} घंटों में {NUM_BIG} ने {PRODUCT} खरीदा",
            "{PRODUCT} में #1 ट्रेंडिंग",
            "आज {NUM_BIG} ग्राहकों ने {PRODUCT} कार्ट में जोड़ा",
            "{CITY} के {NUM_BIG} सत्यापित खरीदारों ने रेट किया",
            "{NAME} और {NUM_BIG} अन्य {PRODUCT} की सलाह देते हैं",
            "{CITY} के खरीदारों का पसंदीदा {PRODUCT}",
            "{NUM_BIG} समीक्षाएँ — आप भी जुड़ें",
            "{CITY} में किसी ने अभी {PRODUCT} खरीदा",
            "बेस्टसेलर — इस हफ़्ते {NUM_BIG} बिके",
            "{CITY} के {NUM_BIG} ग्राहकों ने {PRODUCT} चुना",
            "{NAME} ने अभी रु. {PRICE} बचाए",
            "{NUM_BIG} लोगों की विशलिस्ट में है",
            "{NUM_BIG} लोग देख रहे हैं — केवल {NUM_SMALL} बचे||scarcity",
        ],
        "ne": [
            "{NUM_BIG} जना अहिले यो हेर्दै छन्",
            "{CITY} बाट {NAME} ले भर्खर किन्नुभयो",
            "पछिल्लो {HOURS} घण्टामा {NUM_BIG} ले {PRODUCT} किने",
            "{PRODUCT} मा #1 ट्रेन्डिङ",
            "आज {NUM_BIG} ग्राहकले {PRODUCT} कार्टमा राखे",
            "{CITY} का {NUM_BIG} प्रमाणित खरीददारले मूल्याङ्कन गरे",
            "{NAME} र अन्य {NUM_BIG} जनाले {PRODUCT} सिफारिस गर्छन्",
            "{CITY} का ग्राहकको मन पर्ने {PRODUCT}",
            "{NUM_BIG} समीक्षा — तपाईं पनि जोडिनुहोस्",
            "{CITY} मा कसैले भर्खर {PRODUCT} किन्यो",
            "बेस्टसेलर — यो हप्ता {NUM_BIG} बिक्री",
            "{CITY} का {NUM_BIG} ग्राहकले {PRODUCT} छनोट गरे",
            "{NAME} ले भर्खर रु. {PRICE} बचत गर्नुभयो",
            "{NUM_BIG} जनाको विशलिस्टमा छ",
            "{NUM_BIG} जना हेर्दै — {NUM_SMALL} मात्र बाँकी||scarcity",
        ],
    },
    "forced_action": {
        "en": [
            "Create an account to continue",
            "Sign up to view prices for {PRODUCT}",
            "Subscribe to our newsletter to complete checkout",
            "Enter your phone number to proceed",
            "Allow notifications to continue shopping",
            "Log in with Google to see your cart",
            "You must accept marketing emails to place this order",
            "Verify your number to unlock {PERCENT}% off",
            "Install the app to get {PRODUCT} at Rs. {PRICE}",
            "Share with {NUM_SMALL} friends to unlock free delivery",
            "Add a payment method to start your free trial",
            "Enter card details to continue with the free plan",
            "Sign in to see delivery options for {CITY}",
            "Register to add {PRODUCT} to your wishlist",
            "Accept all cookies to continue browsing",
            "Complete your profile to claim Rs. {PRICE} cashback",
        ],
        "hi": [
            "जारी रखने के लिए खाता बनाएं",
            "{PRODUCT} की कीमत देखने के लिए साइन अप करें",
            "चेकआउट पूरा करने के लिए न्यूज़लेटर सब्सक्राइब करें",
            "आगे बढ़ने के लिए मोबाइल नंबर डालें",
            "खरीदारी जारी रखने के लिए नोटिफिकेशन चालू करें",
            "कार्ट देखने के लिए Google से लॉगिन करें",
            "ऑर्डर देने के लिए मार्केटिंग ईमेल स्वीकार करना ज़रूरी है",
            "{PERCENT}% छूट पाने के लिए नंबर सत्यापित करें",
            "{PRODUCT} को रु. {PRICE} में पाने के लिए ऐप इंस्टॉल करें",
            "मुफ़्त डिलीवरी के लिए {NUM_SMALL} दोस्तों को शेयर करें",
            "फ्री ट्रायल शुरू करने के लिए कार्ड जोड़ें",
            "मुफ़्त प्लान जारी रखने के लिए कार्ड विवरण दर्ज करें",
            "{CITY} के डिलीवरी विकल्प देखने के लिए साइन इन करें",
            "{PRODUCT} विशलिस्ट में जोड़ने के लिए रजिस्टर करें",
            "ब्राउज़िंग जारी रखने के लिए सभी कुकीज़ स्वीकार करें",
            "रु. {PRICE} कैशबैक पाने के लिए प्रोफ़ाइल पूरी करें",
        ],
        "ne": [
            "जारी राख्न खाता बनाउनुहोस्",
            "{PRODUCT} को मूल्य देख्न साइन अप गर्नुहोस्",
            "चेकआउट पूरा गर्न न्यूजलेटर सब्स्क्राइब गर्नुहोस्",
            "अगाडि बढ्न मोबाइल नम्बर हाल्नुहोस्",
            "किनमेल जारी राख्न सूचनाको अनुमति दिनुहोस्",
            "कार्ट देख्न Google बाट लगइन गर्नुहोस्",
            "अर्डर गर्न मार्केटिङ इमेल स्वीकार गर्न अनिवार्य छ",
            "{PERCENT}% छुट पाउन नम्बर प्रमाणित गर्नुहोस्",
            "{PRODUCT} रु. {PRICE} मा पाउन एप इन्स्टल गर्नुहोस्",
            "निःशुल्क डेलिभरीका लागि {NUM_SMALL} साथीलाई सेयर गर्नुहोस्",
            "निःशुल्क ट्रायल सुरु गर्न कार्ड थप्नुहोस्",
            "निःशुल्क प्लान जारी राख्न कार्ड विवरण हाल्नुहोस्",
            "{CITY} का डेलिभरी विकल्प देख्न साइन इन गर्नुहोस्",
            "{PRODUCT} विशलिस्टमा राख्न दर्ता गर्नुहोस्",
            "ब्राउजिङ जारी राख्न सबै कुकिज स्वीकार गर्नुहोस्",
            "रु. {PRICE} क्यासब्याक पाउन प्रोफाइल पूरा गर्नुहोस्",
        ],
    },
    "obstruction": {
        "en": [
            "To cancel, call our support line during business hours",
            "Cancellation requests must be emailed to us",
            "Contact support to delete your account",
            "To unsubscribe, log in and visit your preferences page",
            "Your refund request requires {NUM_SMALL} additional steps",
            "Please contact us within {NUM_SMALL} business days to cancel",
            "Account deletion is not available online",
            "To remove your saved card, write to our team",
            "Chat with an agent to stop your subscription",
            "Manage your plan by visiting our desktop site",
            "Are you sure? Continue to step {NUM_SMALL} to cancel",
            "Refunds are processed only after {DAYS} days of review",
            "To downgrade, submit a request from the {CITY} office portal",
            "Return requests must be raised by phone within {NUM_SMALL} days",
            "Your cancellation needs approval from our team",
        ],
        "hi": [
            "रद्द करने के लिए कार्य समय में सपोर्ट नंबर पर कॉल करें",
            "कैंसिलेशन अनुरोध ईमेल से भेजना ज़रूरी है",
            "खाता हटाने के लिए सपोर्ट से संपर्क करें",
            "अनसब्सक्राइब करने के लिए लॉगिन करके प्राथमिकता पेज पर जाएं",
            "रिफंड के लिए {NUM_SMALL} अतिरिक्त चरण पूरे करें",
            "रद्द करने के लिए {NUM_SMALL} कार्यदिवस में संपर्क करें",
            "ऑनलाइन खाता हटाना उपलब्ध नहीं है",
            "सेव किया कार्ड हटाने के लिए हमें लिखें",
            "सब्सक्रिप्शन बंद करने के लिए एजेंट से चैट करें",
            "प्लान बदलने के लिए डेस्कटॉप साइट पर जाएं",
            "क्या आप निश्चित हैं? रद्द करने के लिए चरण {NUM_SMALL} पर जाएं",
            "रिफंड {DAYS} दिन की समीक्षा के बाद ही होगा",
            "डाउनग्रेड के लिए {CITY} कार्यालय पोर्टल से अनुरोध करें",
            "रिटर्न अनुरोध {NUM_SMALL} दिनों में फोन से करना होगा",
            "आपके रद्दीकरण के लिए टीम की मंज़ूरी चाहिए",
        ],
        "ne": [
            "रद्द गर्न कार्यालय समयमा सपोर्ट नम्बरमा फोन गर्नुहोस्",
            "रद्द गर्ने अनुरोध इमेलबाट पठाउनु अनिवार्य छ",
            "खाता हटाउन सपोर्टमा सम्पर्क गर्नुहोस्",
            "अनसब्स्क्राइब गर्न लगइन गरी प्राथमिकता पृष्ठमा जानुहोस्",
            "रिफन्डका लागि {NUM_SMALL} थप चरण पूरा गर्नुहोस्",
            "रद्द गर्न {NUM_SMALL} कार्य दिनभित्र सम्पर्क गर्नुहोस्",
            "अनलाइन खाता हटाउने सुविधा उपलब्ध छैन",
            "सुरक्षित गरिएको कार्ड हटाउन हामीलाई लेख्नुहोस्",
            "सदस्यता बन्द गर्न एजेन्टसँग च्याट गर्नुहोस्",
            "प्लान परिवर्तन गर्न डेस्कटप साइटमा जानुहोस्",
            "पक्का हो? रद्द गर्न चरण {NUM_SMALL} मा जानुहोस्",
            "रिफन्ड {DAYS} दिनको समीक्षापछि मात्र हुनेछ",
            "डाउनग्रेड गर्न {CITY} कार्यालय पोर्टलबाट अनुरोध गर्नुहोस्",
            "फिर्ता अनुरोध {NUM_SMALL} दिनभित्र फोनबाट गर्नुपर्छ",
            "तपाईंको रद्दीकरणलाई टिमको स्वीकृति आवश्यक छ",
        ],
    },
    "sneaking": {
        "en": [
            "Shipping fee of Rs. {PRICE} added at checkout",
            "By continuing you agree to a recurring Rs. {PRICE} monthly charge",
            "Order protection added to your cart",
            "Service fee of Rs. {PRICE} applied",
            "Your free trial converts to {PLAN} at Rs. {PRICE}/month",
            "Convenience fee of Rs. {PRICE} included",
            "We've added a donation of Rs. {PRICE} to your order",
            "Insurance for {PRODUCT} selected for you",
            "Auto-renewal is enabled for {PLAN}",
            "Priority delivery pre-selected (+Rs. {PRICE})",
            "Includes a {NUM_SMALL}-month {PLAN} subscription",
            "Additional charges may apply at the final step",
            "Extended warranty added — uncheck to remove",
            "Handling charge of Rs. {PRICE} for {CITY} deliveries",
            "{PLAN} membership added to your {PRODUCT} order",
            "Packaging fee Rs. {PRICE} will be shown at payment",
        ],
        "hi": [
            "चेकआउट पर रु. {PRICE} शिपिंग शुल्क जोड़ा गया",
            "जारी रखने पर हर महीने रु. {PRICE} शुल्क लगेगा",
            "ऑर्डर सुरक्षा आपके कार्ट में जोड़ी गई",
            "रु. {PRICE} सेवा शुल्क लागू",
            "फ्री ट्रायल के बाद {PLAN} रु. {PRICE}/महीना हो जाएगा",
            "सुविधा शुल्क रु. {PRICE} शामिल",
            "आपके ऑर्डर में रु. {PRICE} का दान जोड़ा गया",
            "{PRODUCT} का बीमा आपके लिए चुना गया",
            "{PLAN} के लिए ऑटो-रिन्यूअल चालू है",
            "प्राथमिकता डिलीवरी पहले से चुनी गई (+रु. {PRICE})",
            "{NUM_SMALL} महीने की {PLAN} सदस्यता शामिल",
            "अंतिम चरण में अतिरिक्त शुल्क लग सकता है",
            "विस्तारित वारंटी जोड़ी गई — हटाने के लिए अनचेक करें",
            "{CITY} डिलीवरी पर रु. {PRICE} हैंडलिंग शुल्क",
            "आपके {PRODUCT} ऑर्डर में {PLAN} सदस्यता जोड़ी गई",
            "पैकेजिंग शुल्क रु. {PRICE} भुगतान पर दिखेगा",
        ],
        "ne": [
            "चेकआउटमा रु. {PRICE} ढुवानी शुल्क थपियो",
            "जारी राखेमा हरेक महिना रु. {PRICE} शुल्क लाग्नेछ",
            "अर्डर सुरक्षा तपाईंको कार्टमा थपियो",
            "रु. {PRICE} सेवा शुल्क लागू",
            "निःशुल्क ट्रायलपछि {PLAN} रु. {PRICE}/महिना हुनेछ",
            "सुविधा शुल्क रु. {PRICE} समावेश",
            "तपाईंको अर्डरमा रु. {PRICE} दान थपियो",
            "{PRODUCT} को बीमा तपाईंका लागि छनोट गरियो",
            "{PLAN} का लागि स्वतः नवीकरण सक्रिय छ",
            "प्राथमिकता डेलिभरी पहिले नै छनोट (+रु. {PRICE})",
            "{NUM_SMALL} महिनाको {PLAN} सदस्यता समावेश",
            "अन्तिम चरणमा थप शुल्क लाग्न सक्छ",
            "विस्तारित वारेन्टी थपियो — हटाउन अनचेक गर्नुहोस्",
            "{CITY} डेलिभरीमा रु. {PRICE} ह्यान्डलिङ शुल्क",
            "तपाईंको {PRODUCT} अर्डरमा {PLAN} सदस्यता थपियो",
            "प्याकेजिङ शुल्क रु. {PRICE} भुक्तानीमा देखिनेछ",
        ],
    },
    # BENIGN: deliberately includes hard negatives that look like positives
    "benign": {
        "en": [
            "Add {PRODUCT} to cart",
            "Free shipping on orders above Rs. {PRICE}",
            "Product details",
            "Customer reviews ({NUM_BIG})",
            "Return within {NUM_SMALL} days",
            "Size guide for {PRODUCT}",
            "Track your order",
            "Secure payment",
            "In stock",
            "Cash on delivery available in {CITY}",
            "{PERCENT}% off",
            "Add to wishlist",
            "Compare {PRODUCT}",
            "Proceed to checkout",
            "Search for {PRODUCT}",
            "Sort by price",
            "Filter by brand",
            "Save address",
            "Order summary",
            "Apply coupon",
            "View all {PRODUCT}",
            "Contact us",
            "Privacy policy",
            "{NUM_BIG} verified reviews",
            "Estimated delivery: {DAYS} days",
            "Your order has been placed",
            "Sign in",
            "Create account",
            "Continue as guest",
            "Categories",
            "Today's offers",
            "Buy now",
            "Out of stock",
            "Notify me when {PRODUCT} is available",
            "EMI options available from Rs. {PRICE}/month",
            "Exchange offer up to Rs. {PRICE}",
            "Warranty: {NUM_SMALL} year",
            "Delivering to {CITY}",
            "My orders",
            "Cancel order",
            "Unsubscribe from emails",
            "Manage your subscription in Settings",
            "Delete my account",
            "Shipping fee: Rs. {PRICE} (shown before payment)",
            "You can cancel anytime from your account page",
            "Price: Rs. {PRICE}",
            "{PRODUCT} — Rs. {PRICE}",
            "Sale ends {DAYS} November",
            "{NUM_BIG} units sold",
            "Seller: {NAME} Traders, {CITY}",
            "Recommended for you",
            "Frequently bought together",
            "Log in for a faster checkout (optional)",
            "No thanks",
            "Close",
            "Continue shopping",
            "Skip",
            "Not now",
            "Decline",
            "Terms and conditions",
            "Refund policy: refunds in {DAYS} working days",
            "Newsletter (optional)",
            "Allow notifications? You can change this later",
        ],
        "hi": [
            "{PRODUCT} कार्ट में जोड़ें",
            "रु. {PRICE} से ऊपर के ऑर्डर पर मुफ़्त शिपिंग",
            "उत्पाद विवरण",
            "ग्राहक समीक्षाएँ ({NUM_BIG})",
            "{NUM_SMALL} दिनों में वापसी",
            "{PRODUCT} के लिए साइज़ गाइड",
            "अपना ऑर्डर ट्रैक करें",
            "सुरक्षित भुगतान",
            "स्टॉक में उपलब्ध",
            "{CITY} में कैश ऑन डिलीवरी उपलब्ध",
            "{PERCENT}% छूट",
            "विशलिस्ट में जोड़ें",
            "{PRODUCT} की तुलना करें",
            "चेकआउट पर जाएं",
            "{PRODUCT} खोजें",
            "कीमत से क्रमबद्ध करें",
            "ब्रांड से फ़िल्टर करें",
            "पता सहेजें",
            "ऑर्डर सारांश",
            "कूपन लगाएं",
            "सभी {PRODUCT} देखें",
            "हमसे संपर्क करें",
            "गोपनीयता नीति",
            "{NUM_BIG} सत्यापित समीक्षाएँ",
            "अनुमानित डिलीवरी: {DAYS} दिन",
            "आपका ऑर्डर दर्ज हो गया",
            "साइन इन करें",
            "खाता बनाएं",
            "गेस्ट के रूप में जारी रखें",
            "श्रेणियाँ",
            "आज के ऑफ़र",
            "अभी खरीदें",
            "स्टॉक ख़त्म",
            "{PRODUCT} उपलब्ध होने पर सूचित करें",
            "रु. {PRICE}/महीना से EMI विकल्प",
            "रु. {PRICE} तक एक्सचेंज ऑफ़र",
            "वारंटी: {NUM_SMALL} साल",
            "{CITY} में डिलीवरी",
            "मेरे ऑर्डर",
            "ऑर्डर रद्द करें",
            "ईमेल से अनसब्सक्राइब करें",
            "सेटिंग्स में सब्सक्रिप्शन प्रबंधित करें",
            "मेरा खाता हटाएं",
            "शिपिंग शुल्क: रु. {PRICE} (भुगतान से पहले दिखेगा)",
            "आप कभी भी अपने खाते से रद्द कर सकते हैं",
            "कीमत: रु. {PRICE}",
            "{PRODUCT} — रु. {PRICE}",
            "{NUM_BIG} इकाई बिकीं",
            "विक्रेता: {NAME} ट्रेडर्स, {CITY}",
            "आपके लिए सुझाव",
            "साथ में खरीदे जाते हैं",
            "तेज़ चेकआउट के लिए लॉगिन करें (वैकल्पिक)",
            "नहीं धन्यवाद",
            "बंद करें",
            "खरीदारी जारी रखें",
            "छोड़ें",
            "अभी नहीं",
            "अस्वीकार करें",
            "नियम और शर्तें",
            "रिफंड नीति: {DAYS} कार्यदिवस में रिफंड",
            "न्यूज़लेटर (वैकल्पिक)",
            "नोटिफिकेशन चालू करें? बाद में बदल सकते हैं",
        ],
        "ne": [
            "{PRODUCT} कार्टमा राख्नुहोस्",
            "रु. {PRICE} माथिको अर्डरमा निःशुल्क ढुवानी",
            "उत्पादन विवरण",
            "ग्राहक समीक्षा ({NUM_BIG})",
            "{NUM_SMALL} दिनभित्र फिर्ता",
            "{PRODUCT} का लागि साइज गाइड",
            "तपाईंको अर्डर ट्रयाक गर्नुहोस्",
            "सुरक्षित भुक्तानी",
            "स्टकमा उपलब्ध",
            "{CITY} मा क्यास अन डेलिभरी उपलब्ध",
            "{PERCENT}% छुट",
            "विशलिस्टमा राख्नुहोस्",
            "{PRODUCT} तुलना गर्नुहोस्",
            "चेकआउटमा जानुहोस्",
            "{PRODUCT} खोज्नुहोस्",
            "मूल्य अनुसार क्रमबद्ध गर्नुहोस्",
            "ब्रान्ड अनुसार फिल्टर गर्नुहोस्",
            "ठेगाना सुरक्षित गर्नुहोस्",
            "अर्डर सारांश",
            "कुपन लागू गर्नुहोस्",
            "सबै {PRODUCT} हेर्नुहोस्",
            "हामीलाई सम्पर्क गर्नुहोस्",
            "गोपनीयता नीति",
            "{NUM_BIG} प्रमाणित समीक्षा",
            "अनुमानित डेलिभरी: {DAYS} दिन",
            "तपाईंको अर्डर दर्ता भयो",
            "साइन इन गर्नुहोस्",
            "खाता बनाउनुहोस्",
            "अतिथिको रूपमा जारी राख्नुहोस्",
            "श्रेणीहरू",
            "आजका अफरहरू",
            "अहिले किन्नुहोस्",
            "स्टक सकियो",
            "{PRODUCT} उपलब्ध भएपछि जानकारी दिनुहोस्",
            "रु. {PRICE}/महिनाबाट EMI विकल्प",
            "रु. {PRICE} सम्म एक्सचेन्ज अफर",
            "वारेन्टी: {NUM_SMALL} वर्ष",
            "{CITY} मा डेलिभरी",
            "मेरो अर्डर",
            "अर्डर रद्द गर्नुहोस्",
            "इमेलबाट अनसब्स्क्राइब गर्नुहोस्",
            "सेटिङमा सदस्यता व्यवस्थापन गर्नुहोस्",
            "मेरो खाता हटाउनुहोस्",
            "ढुवानी शुल्क: रु. {PRICE} (भुक्तानी अघि देखिने)",
            "तपाईं कुनै पनि समय खाताबाट रद्द गर्न सक्नुहुन्छ",
            "मूल्य: रु. {PRICE}",
            "{PRODUCT} — रु. {PRICE}",
            "{NUM_BIG} थान बिक्री भयो",
            "बिक्रेता: {NAME} ट्रेडर्स, {CITY}",
            "तपाईंका लागि सिफारिस",
            "सँगै किनिने सामान",
            "छिटो चेकआउटका लागि लगइन गर्नुहोस् (वैकल्पिक)",
            "पर्दैन धन्यवाद",
            "बन्द गर्नुहोस्",
            "किनमेल जारी राख्नुहोस्",
            "छोड्नुहोस्",
            "अहिले होइन",
            "अस्वीकार गर्नुहोस्",
            "नियम र सर्तहरू",
            "रिफन्ड नीति: {DAYS} कार्य दिनमा रिफन्ड",
            "न्यूजलेटर (वैकल्पिक)",
            "सूचना अनुमति दिने? पछि परिवर्तन गर्न सकिन्छ",
        ],
    },
}

# Plausible DOM context per label (feature engineering, not decoration)
TAGS = {
    "confirmshaming": [("button", "decline"), ("a", "decline"), ("span", "modal_text")],
    "false_urgency": [("span", "timer"), ("div", "banner"), ("p", "promo")],
    "forced_action": [("button", "cta"), ("label", "form_gate"), ("p", "modal_text")],
    "obstruction": [("p", "help_text"), ("a", "support_link"), ("div", "modal_text")],
    "scarcity": [("span", "stock"), ("div", "badge"), ("p", "promo")],
    "sneaking": [("label", "checkbox"), ("span", "line_item"), ("p", "fine_print")],
    "social_proof": [("span", "toast"), ("div", "badge"), ("p", "promo")],
    "benign": [
        ("button", "cta"), ("a", "nav"), ("span", "label"), ("p", "body"),
        ("h2", "heading"), ("li", "nav"), ("label", "form"),
    ],
}

SLOT_RE = re.compile(r"\{([A-Z_]+)\}")


def fill(template: str, lang: str, rng: random.Random) -> str:
    vocab = SLOTS[lang]

    def sub(m):
        key = m.group(1)
        if key not in vocab:
            raise KeyError(f"Unknown slot {key} for lang {lang}")
        return rng.choice(vocab[key])

    return SLOT_RE.sub(sub, template)


# ---------------------------------------------------------------------------
# Label overrides (v2.1)
#
# These templates were originally filed under a dark class but violate the
# annotation rule: a statistic is manipulative only when it induces urgency or
# peer pressure through UNVERIFIABLE REAL-TIME ACTIVITY. A static, verifiable
# aggregate is benign, and a real stated deadline is benign.
#
# Overriding by template_id rather than moving the strings between lists keeps
# every template index stable, so template_ids stay comparable across dataset
# versions. Moving them would silently renumber everything after them.
# ---------------------------------------------------------------------------
LABEL_OVERRIDES = {
    # "Rated by {NUM_BIG} verified buyers in {CITY}" -- auditable rating count.
    # The benign list already contained "{NUM_BIG} verified reviews", so the same
    # concept carried both labels. That contradiction collapsed social_proof's
    # tuned threshold to 0.13 and leaked 19% of its rows into other classes.
    "social_proof:en:05": "benign",
    "social_proof:hi:05": "benign",
    "social_proof:ne:05": "benign",
    # "Bestseller -- {NUM_BIG} sold this week" -- verifiable sales aggregate.
    "social_proof:en:10": "benign",
    "social_proof:hi:10": "benign",
    "social_proof:ne:10": "benign",
    # "Order in {TIME} to get delivery in {DAYS} days" -- a real shipping cutoff.
    # The model correctly predicted [] on these and was penalised for it.
    "false_urgency:en:16": "benign",
    "false_urgency:hi:16": "benign",
    "false_urgency:ne:16": "benign",
}


def parse_template(raw: str):
    if "||" in raw:
        text, extra = raw.split("||", 1)
        return text, [e.strip() for e in extra.split(",") if e.strip()]
    return raw, []


def generate():
    rng = random.Random(SEED)
    rows = []
    seen = set()
    shortfalls = {}

    for label in LABELS:
        target = N_BENIGN_PER_LANG if label == "benign" else N_PER_DARK_PER_LANG
        for lang in LANGS:
            raws = TEMPLATES[label][lang]
            parsed = [parse_template(r) for r in raws]
            exhausted = [False] * len(parsed)
            produced = 0
            chunk = max(1, target // (len(parsed) * 3))
            while produced < target and not all(exhausted):
              for t_idx, (template_text, extra_labels) in enumerate(parsed):
                if produced >= target or exhausted[t_idx]:
                    continue
                template_id = f"{label}:{lang}:{t_idx:02d}"
                made = 0
                misses = 0
                while made < chunk and misses < 300 and produced < target:
                    text = fill(template_text, lang, rng).strip()
                    key = (lang, text)
                    if key in seen:
                        misses += 1
                        continue
                    seen.add(key)
                    tag, role = rng.choice(TAGS[label])
                    override = LABEL_OVERRIDES.get(template_id)
                    if override is not None:
                        labels = [override]
                        primary = override
                    else:
                        labels = [label] + [e for e in extra_labels if e != label]
                        primary = label
                    rows.append(
                        {
                            "text": text,
                            "labels": "|".join(labels),
                            "primary_label": primary,
                            "lang": lang,
                            "tag": tag,
                            "role": role,
                            "model_input": f"[TAG={tag}] [ROLE={role}] {text}",
                            "template_id": template_id,
                            "source": "synthetic_v1",
                        }
                    )
                    made += 1
                    produced += 1
                if misses >= 300:
                    exhausted[t_idx] = True
            if produced < target:
                shortfalls[f"{label}/{lang}"] = {"target": target, "got": produced}

    # one-hot columns
    for r in rows:
        active = set(r["labels"].split("|"))
        for l in LABELS:
            r[f"y_{l}"] = 1 if l in active else 0

    rng.shuffle(rows)
    return rows, shortfalls


def write_csv(path, rows, fieldnames):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def template_disjoint_split(rows, rng):
    """Hold out whole templates so test phrasings are never seen in training."""
    by_group = defaultdict(list)
    for r in rows:
        by_group[(r["primary_label"], r["lang"])].append(r["template_id"])

    train_t, val_t, test_t = set(), set(), set()
    for group, tids in by_group.items():
        uniq = sorted(set(tids))
        rng.shuffle(uniq)
        n = len(uniq)
        n_test = max(2, round(n * 0.2))
        n_val = max(1, round(n * 0.15))
        test_t.update(uniq[:n_test])
        val_t.update(uniq[n_test:n_test + n_val])
        train_t.update(uniq[n_test + n_val:])

    splits = {"train": [], "val": [], "test": []}
    for r in rows:
        if r["template_id"] in test_t:
            splits["test"].append(r)
        elif r["template_id"] in val_t:
            splits["val"].append(r)
        else:
            splits["train"].append(r)
    return splits


def random_split(rows, rng):
    shuffled = list(rows)
    rng.shuffle(shuffled)
    n = len(shuffled)
    n_test = int(n * 0.15)
    n_val = int(n * 0.15)
    return {
        "test": shuffled[:n_test],
        "val": shuffled[n_test:n_test + n_val],
        "train": shuffled[n_test + n_val:],
    }


def main():
    rows, shortfalls = generate()
    fieldnames = [
        "text", "labels", "primary_label", "lang", "tag", "role",
        "model_input", "template_id", "source",
    ] + [f"y_{l}" for l in LABELS]

    write_csv(f"{OUTDIR}/dataset_all.csv", rows, fieldnames)

    # per-class files, matching the user's existing naming convention
    for label in LABELS:
        subset = [r for r in rows if r["primary_label"] == label]
        write_csv(f"{OUTDIR}/per_class/dark_pattern_{label}.csv", subset, fieldnames)

    rng = random.Random(SEED + 1)
    td = template_disjoint_split(rows, rng)
    for name, subset in td.items():
        write_csv(f"{OUTDIR}/split_template_disjoint/{name}.csv", subset, fieldnames)

    rs = random_split(rows, random.Random(SEED + 2))
    for name, subset in rs.items():
        write_csv(f"{OUTDIR}/split_random/{name}.csv", subset, fieldnames)

    stats = {
        "seed": SEED,
        "total_rows": len(rows),
        "labels": LABELS,
        "langs": LANGS,
        "per_primary_label": dict(Counter(r["primary_label"] for r in rows)),
        "per_lang": dict(Counter(r["lang"] for r in rows)),
        "per_label_lang": {
            f"{l}/{g}": c
            for (l, g), c in Counter(
                (r["primary_label"], r["lang"]) for r in rows
            ).items()
        },
        "multi_label_rows": sum(1 for r in rows if "|" in r["labels"]),
        "label_positives": {l: sum(r[f"y_{l}"] for r in rows) for l in LABELS},
        "unique_templates": len({r["template_id"] for r in rows}),
        "split_template_disjoint": {k: len(v) for k, v in td.items()},
        "split_random": {k: len(v) for k, v in rs.items()},
        "shortfalls": shortfalls,
    }
    with open(f"{OUTDIR}/stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
