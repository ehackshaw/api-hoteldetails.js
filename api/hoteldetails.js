
/*
========================================================
BOKKARA — HOTEL DETAILS BACKEND
File: api/hoteldetails.js
========================================================

FEATURES
- One Shopify-to-Vercel request
- Google Hotels property details
- Google Hotels photo gallery
- Up to 50 guest reviews
- Review pagination handled by backend
- Room-specific photo extraction
- Room gallery section matching
- Normalized room and booking information
- Existing Shopify frontend compatibility
- No fabricated property or room data

ENVIRONMENT VARIABLE
SERPAPI_API_KEY=your_private_key
========================================================
*/

const SERPAPI_URL = "https://serpapi.com/search.json";
const TIMEOUT_MS = 25000;
const MAX_REVIEWS = 50;
const MAX_REVIEW_PAGES = 5;

/* =====================================================
   HELPERS
===================================================== */

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v
    : {};
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function first(...values) {
  return values.find(
    v => v !== undefined && v !== null && v !== ""
  ) ?? null;
}

function str(v) {
  return v === null ||
    v === undefined ||
    typeof v === "object"
    ? ""
    : String(v).trim();
}

function num(v) {
  if (v === null || v === undefined || v === "") {
    return null;
  }

  if (typeof v === "object") {
    return num(
      first(
        v.extracted_lowest,
        v.extracted_price,
        v.amount,
        v.value
      )
    );
  }

  const n = Number(
    String(v).replace(/[^0-9.-]/g, "")
  );

  return Number.isFinite(n) ? n : null;
}

function url(v) {
  const s = str(v);
  return /^https?:\/\//i.test(s) ? s : "";
}

function unique(items, key) {
  const seen = new Set();

  return items.filter(item => {
    const k = key(item);

    if (!k || seen.has(k)) return false;

    seen.add(k);
    return true;
  });
}

function dateValue(v) {
  const s = str(v);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00Z");

    return !Number.isNaN(d.getTime()) &&
      d.toISOString().slice(0, 10) === s
      ? s
      : "";
  }

  if (!s) return "";

  const d = new Date(s);

  return Number.isNaN(d.getTime())
    ? ""
    : d.toISOString().slice(0, 10);
}

function integer(v, fallback, min, max) {
  const n = Number(v);

  return Number.isInteger(n) &&
    n >= min &&
    n <= max
    ? n
    : fallback;
}

function normalizeRate(v) {
  const r = obj(v);

  return {
    display: str(
      first(r.lowest, r.price, r.amount)
    ),

    amount: num(
      first(
        r.extracted_lowest,
        r.extracted_price,
        r.amount
      )
    ),

    before_taxes_fees: str(r.before_taxes_fees),

    before_taxes_fees_amount: num(
      r.extracted_before_taxes_fees
    ),

    raw: r
  };
}

/* =====================================================
   SEARCH PARAMETERS
===================================================== */

function getQuery(req) {
  const q = req.method === "POST"
    ? obj(req.body)
    : obj(req.query);

  const currency = str(
    q.currency || "USD"
  ).toUpperCase();

  return {
    property_token: str(
      first(
        q.property_token,
        q.propertyToken,
        q.token
      )
    ),

    destination: str(
      first(
        q.destination,
        q.q,
        q.location
      )
    ),

    checkin: dateValue(
      first(
        q.checkin,
        q.check_in_date
      )
    ),

    checkout: dateValue(
      first(
        q.checkout,
        q.check_out_date
      )
    ),

    rooms: integer(q.rooms, 1, 1, 10),
    adults: integer(q.adults, 2, 1, 40),
    children: integer(q.children, 0, 0, 40),
    babies: integer(q.babies, 0, 0, 40),
    seniors: integer(q.seniors, 0, 0, 40),

    children_ages: str(q.children_ages),

    currency: /^[A-Z]{3}$/.test(currency)
      ? currency
      : "USD",

    hl: "en",
    gl: "us"
  };
}

function validateQuery(q) {
  if (
    !q.property_token ||
    q.property_token.length > 2048
  ) {
    throw new Error(
      "A valid property_token is required."
    );
  }

  if (!q.destination) {
    throw new Error(
      "Destination is required."
    );
  }

  if (!q.checkin || !q.checkout) {
    throw new Error(
      "Valid check-in and check-out dates are required."
    );
  }

  if (q.checkout <= q.checkin) {
    throw new Error(
      "Checkout must be later than check-in."
    );
  }

  if (q.children_ages) {
    const ages = q.children_ages.split(",");

    if (
      ages.length !== q.children ||
      ages.some(age =>
        !/^\d{1,2}$/.test(age.trim()) ||
        Number(age) < 1 ||
        Number(age) > 17
      )
    ) {
      throw new Error(
        "Invalid children_ages."
      );
    }
  }
}

/* =====================================================
   SERPAPI REQUEST
===================================================== */

async function callSerpApi(engine, params, apiKey) {
  const endpoint = new URL(SERPAPI_URL);

  endpoint.searchParams.set("engine", engine);
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("output", "json");

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      endpoint.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(
        str(data.error) ||
        `${engine} returned HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* =====================================================
   HOTEL PHOTOS
===================================================== */

function normalizePhoto(v, section = "") {
  const p = typeof v === "string"
    ? { url: v }
    : obj(v);

  const imageUrl = url(
    first(
      p.original_image,
      p.image,
      p.url,
      p.src,
      p.thumbnail
    )
  );

  if (!imageUrl) return null;

  return {
    url: imageUrl,

    original_image:
      url(p.original_image) || imageUrl,

    thumbnail:
      url(p.thumbnail) || imageUrl,

    title: str(
      first(
        p.title,
        p.caption,
        p.description
      )
    ),

    section,

    raw: p
  };
}

function photoItems(value, section = "") {
  const items = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];

  return items
    .map(item => normalizePhoto(item, section))
    .filter(Boolean);
}

function normalizePhotos(data) {
  const d = obj(data);

  const sections = arr(d.sections).map(section => {
    const s = obj(section);
    const title = str(s.title);

    return {
      title,

      total: num(s.total),

      photos: photoItems(
        first(s.photos, s.images),
        title
      ),

      next_page_token:
        str(s.next_page_token) || null,

      raw: s
    };
  });

  const topPhotos = photoItems(
    first(d.photos, d.images)
  );

  const photos = unique(
    [
      ...topPhotos,
      ...sections.flatMap(s => s.photos)
    ],
    p => p.url
  );

  return {
    sections,
    photos,
    photo_urls: photos.map(p => p.url),
    photo_count_loaded: photos.length,

    has_more_photos: sections.some(
      s => Boolean(s.next_page_token)
    )
  };
}

/* =====================================================
   ROOM PHOTOS
===================================================== */

function roomName(room) {
  const r = obj(room);

  return str(
    first(
      r.name,
      r.room_name,
      r.title,
      r.type
    )
  );
}

function normalizeRoom(room, sections = []) {
  const r = obj(room);
  const name = roomName(r);

  const directPhotos = [
    ...photoItems(r.images),
    ...photoItems(r.photos),
    ...photoItems(r.room_images),
    ...photoItems(r.room_photos),
    ...photoItems(r.image),
    ...photoItems(r.thumbnail),
    ...photoItems(r.photo)
  ];

  /*
    Match gallery sections only when their labels
    explicitly correspond to this room type.
    Do not substitute general property photos.
  */

  const roomSections = sections.filter(section => {
    const title = str(
      section.title
    ).toLowerCase().trim();

    const label = name.toLowerCase().trim();

    return (
      title.length >= 4 &&
      label.length >= 4 &&
      (
        title === label ||
        title.includes(label) ||
        label.includes(title)
      )
    );
  });

  const images = unique(
    [
      ...directPhotos,
      ...roomSections.flatMap(
        section => arr(section.photos)
      )
    ],
    image => image.url
  );

  return {
    ...r,

    name,

    images,

    photos: images.map(
      image => image.url
    ),

    image: images[0]?.url || "",

    thumbnail:
      images[0]?.thumbnail || "",

    image_count: images.length,

    has_room_photos:
      images.length > 0
  };
}

function attachRoomImages(hotel, gallery) {
  const sections = arr(gallery.sections);

  hotel.room_options = arr(
    hotel.room_options
  ).map(room =>
    normalizeRoom(room, sections)
  );

  hotel.booking_options = arr(
    hotel.booking_options
  ).map(option => ({
    ...option,

    rooms: arr(option.rooms).map(
      room => normalizeRoom(room, sections)
    )
  }));

  const featuredCount =
    hotel.featured_prices.length;

  hotel.featured_prices =
    hotel.booking_options.slice(
      0,
      featuredCount
    );

  hotel.prices =
    hotel.booking_options.slice(
      featuredCount
    );
}

/* =====================================================
   BOOKING OPTIONS
===================================================== */

function normalizeBookingOption(value) {
  const o = obj(value);

  return {
    source: str(
      first(o.source, o.name)
    ),

    link: url(o.link),

    logo: url(o.logo),

    num_guests: num(o.num_guests),

    rate_per_night: normalizeRate(
      o.rate_per_night
    ),

    total_rate: normalizeRate(
      o.total_rate
    ),

    rooms: arr(o.rooms),

    benefits: first(
      o.benefits,
      null
    ),

    raw: o
  };
}

/* =====================================================
   PROPERTY NORMALIZATION
===================================================== */

function normalizeProperty(data, q) {
  const p = obj(data);

  const gps = obj(
    p.gps_coordinates
  );

  const address = str(
    first(
      p.address,
      p.formatted_address,
      p.full_address,
      p.street_address
    )
  );

  const featured = arr(
    p.featured_prices
  ).map(normalizeBookingOption);

  const prices = arr(
    p.prices
  ).map(normalizeBookingOption);

  const nightly = normalizeRate(
    p.rate_per_night
  );

  const total = normalizeRate(
    p.total_rate
  );

  const rating = num(
    first(
      p.overall_rating,
      p.rating,
      p.guest_rating
    )
  );

  const nights = Math.round(
    (
      Date.parse(q.checkout + "T00:00:00Z") -
      Date.parse(q.checkin + "T00:00:00Z")
    ) / 86400000
  );

  return {
    property_token: str(
      first(
        p.property_token,
        q.property_token
      )
    ),

    name: str(p.name),
    type: str(p.type),
    description: str(p.description),

    website: url(p.link),
    logo: url(p.logo),

    address,
    address_available: Boolean(address),
    location_label: address || q.destination,

    phone: str(p.phone),
    phone_link: str(p.phone_link),

    gps_coordinates: {
      latitude: num(gps.latitude),
      longitude: num(gps.longitude)
    },

    check_in_time: str(p.check_in_time),
    check_out_time: str(p.check_out_time),

    stars: num(
      first(
        p.extracted_hotel_class,
        p.hotel_class,
        p.stars
      )
    ),

    hotel_class: str(p.hotel_class),

    rating,

    rating_display:
      rating === null
        ? null
        : rating.toFixed(1),

    review_count: num(
      first(
        p.reviews,
        p.review_count
      )
    ),

    location_rating: num(
      p.location_rating
    ),

    reviews_breakdown:
      first(p.reviews_breakdown, null),

    other_reviews:
      first(p.other_reviews, null),

    amenities: arr(p.amenities),

    excluded_amenities:
      arr(p.excluded_amenities),

    amenities_detailed:
      first(p.amenities_detailed, null),

    essential_info:
      first(p.essential_info, null),

    nearby_places:
      arr(p.nearby_places),

    eco_certified:
      p.eco_certified === true,

    sustainability:
      first(p.sustainability, null),

    accessibility:
      first(p.accessibility, null),

    rate_per_night: nightly,
    total_rate: total,

    price_per_night: nightly.amount,
    total_price: total.amount,

    currency: q.currency,
    nights,

    featured_prices: featured,
    prices,

    booking_options: [
      ...featured,
      ...prices
    ],

    room_options: arr(p.rooms),

    policies: first(p.policies, null),

    images: arr(p.images),

    thumbnail: url(p.thumbnail),

    raw: p
  };
}

/* =====================================================
   GUEST REVIEWS
===================================================== */

function normalizeReview(value) {
  const r = obj(value);
  const user = obj(r.user);

  return {
    author: str(
      first(
        user.name,
        r.author
      )
    ),

    author_url: url(user.link),

    author_photo: url(
      first(
        user.thumbnail,
        user.image
      )
    ),

    source: str(r.source),

    source_icon: url(
      r.source_icon
    ),

    rating: num(r.rating),

    best_rating: num(
      r.best_rating
    ),

    date: str(r.date),

    text: str(
      first(
        r.snippet,
        r.text
      )
    ),

    link: url(r.link),

    images: arr(r.images),

    subratings:
      first(r.subratings, null),

    hotel_highlights:
      arr(r.hotel_highlights),

    review_details:
      first(
        r.details,
        r.review_details,
        null
      ),

    raw: r
  };
}

function normalizeReviews(data) {
  const d = obj(data);

  const reviews = arr(
    d.reviews
  ).map(normalizeReview);

  return {
    reviews,

    review_count_loaded:
      reviews.length,

    next_page_token: str(
      first(
        obj(d.serpapi_pagination).next_page_token,
        obj(d.pagination).next_page_token,
        d.next_page_token
      )
    ) || null,

    pagination: first(
      d.serpapi_pagination,
      d.pagination,
      null
    )
  };
}

/* =====================================================
   FETCH UP TO 50 REVIEWS
===================================================== */

async function collectReviews(
  initialData,
  reviewParams,
  apiKey
) {
  const initial = normalizeReviews(
    initialData
  );

  const collected = [
    ...initial.reviews
  ];

  const pages = [
    initialData
  ];

  const errors = [];
  const seenTokens = new Set();

  let nextToken =
    initial.next_page_token;

  let requestsAttempted = 0;
  let requestsSucceeded = 0;

  for (
    let page = 1;
    page < MAX_REVIEW_PAGES &&
    collected.length < MAX_REVIEWS &&
    nextToken;
    page++
  ) {
    if (seenTokens.has(nextToken)) {
      break;
    }

    seenTokens.add(nextToken);

    requestsAttempted++;

    try {
      const nextData = await callSerpApi(
        "google_hotels_reviews",
        {
          ...reviewParams,
          next_page_token: nextToken
        },
        apiKey
      );

      requestsSucceeded++;

      const parsed = normalizeReviews(
        nextData
      );

      pages.push(nextData);

      collected.push(
        ...parsed.reviews
      );

      nextToken =
        parsed.next_page_token;

      if (!parsed.reviews.length) {
        break;
      }

    } catch (error) {
      errors.push(
        error.message ||
        "Unable to load another review page."
      );

      break;
    }
  }

  const reviews = unique(
    collected,
    review => [
      review.link,
      review.author,
      review.date,
      review.text
    ].join("|")
  ).slice(0, MAX_REVIEWS);

  return {
    reviews,

    review_count_loaded:
      reviews.length,

    next_page_token: nextToken,

    pages_loaded: pages.length,

    requests_attempted:
      requestsAttempted,

    requests_succeeded:
      requestsSucceeded,

    errors
  };
}

/* =====================================================
   CLEAN RAW SOURCE
===================================================== */

function cleanRaw(data) {
  return Object.fromEntries(
    Object.entries(obj(data)).filter(
      ([key]) => ![
        "search_metadata",
        "search_parameters",
        "search_information"
      ].includes(key)
    )
  );
}

/* =====================================================
   MAIN VERCEL HANDLER
===================================================== */

export default async function handler(req, res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const apiKey =
    process.env.SERPAPI_API_KEY ||
    process.env.SERPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error:
        "SERPAPI_API_KEY is not configured."
    });
  }

  let q;

  try {
    q = getQuery(req);
    validateQuery(q);

  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  /* ---------------------------------------------
     PROPERTY SEARCH
  --------------------------------------------- */

  const propertyParams = {
    property_token: q.property_token,

    q: q.destination,

    check_in_date: q.checkin,
    check_out_date: q.checkout,

    adults: q.adults,
    children: q.children,

    currency: q.currency,

    hl: q.hl,
    gl: q.gl
  };

  if (
    q.children > 0 &&
    q.children_ages
  ) {
    propertyParams.children_ages =
      q.children_ages;
  }

  /* ---------------------------------------------
     PHOTO SEARCH
  --------------------------------------------- */

  const photoParams = {
    property_token: q.property_token,
    hl: q.hl
  };

  /* ---------------------------------------------
     REVIEW SEARCH
  --------------------------------------------- */

  const reviewParams = {
    property_token: q.property_token,
    hl: q.hl,
    sort_by: 1
  };

  /* ---------------------------------------------
     THREE INITIAL PARALLEL REQUESTS
  --------------------------------------------- */

  const engines = [
    "google_hotels",
    "google_hotels_photos",
    "google_hotels_reviews"
  ];

  const settled = await Promise.allSettled([
    callSerpApi(
      engines[0],
      propertyParams,
      apiKey
    ),

    callSerpApi(
      engines[1],
      photoParams,
      apiKey
    ),

    callSerpApi(
      engines[2],
      reviewParams,
      apiKey
    )
  ]);

  const status = {};
  const data = {};

  for (
    let i = 0;
    i < engines.length;
    i++
  ) {
    const engine = engines[i];
    const result = settled[i];

    if (result.status === "fulfilled") {
      status[engine] = {
        success: true,
        error: null
      };

      data[engine] = result.value;

    } else {
      status[engine] = {
        success: false,

        error:
          result.reason?.message ||
          "Request failed"
      };

      data[engine] = {};
    }
  }

  /* ---------------------------------------------
     PROPERTY RESPONSE REQUIRED
  --------------------------------------------- */

  if (!status.google_hotels.success) {
    return res.status(502).json({
      success: false,

      error:
        "Unable to retrieve hotel property details.",

      property_token:
        q.property_token,

      sources: status
    });
  }

  const propertyData =
    data.google_hotels;

  if (!str(propertyData.name)) {
    return res.status(404).json({
      success: false,

      error:
        "No matching property details were returned.",

      property_token:
        q.property_token,

      sources: status
    });
  }

  /* ---------------------------------------------
     NORMALIZE PROPERTY AND PHOTOS
  --------------------------------------------- */

  const hotel = normalizeProperty(
    propertyData,
    q
  );

  const gallery = normalizePhotos(
    data.google_hotels_photos
  );

  attachRoomImages(
    hotel,
    gallery
  );

  /* ---------------------------------------------
     COLLECT REVIEWS
  --------------------------------------------- */

  let reviewData = {
    reviews: [],
    review_count_loaded: 0,
    next_page_token: null,
    pages_loaded: 0,
    requests_attempted: 0,
    requests_succeeded: 0,
    errors: []
  };

  if (status.google_hotels_reviews.success) {
    reviewData = await collectReviews(
      data.google_hotels_reviews,
      reviewParams,
      apiKey
    );
  }

  /* ---------------------------------------------
     COMBINE PROPERTY PHOTOS
  --------------------------------------------- */

  const propertyImages = photoItems(
    propertyData.images,
    "Property"
  );

  if (hotel.thumbnail) {
    propertyImages.unshift({
      url: hotel.thumbnail,

      original_image:
        hotel.thumbnail,

      thumbnail:
        hotel.thumbnail,

      title: "",
      section: "Property",
      raw: {}
    });
  }

  const allPhotos = unique(
    [
      ...gallery.photos,
      ...propertyImages
    ],
    photo => photo.url
  );

  /* ---------------------------------------------
     FINAL RESPONSE
  --------------------------------------------- */

  const totalAttempts =
    3 + reviewData.requests_attempted;

  const totalSucceeded =
    Object.values(status).filter(
      s => s.success
    ).length +
    reviewData.requests_succeeded;

  return res.status(200).json({

    success: true,

    partial: !(
      status.google_hotels_photos.success &&
      status.google_hotels_reviews.success
    ) || reviewData.errors.length > 0,

    property_token:
      q.property_token,

    /* HOTEL */

    hotel: {
      ...hotel,

      images: allPhotos,

      photos: allPhotos.map(
        photo => photo.url
      ),

      image:
        allPhotos[0]?.url || "",

      image_count:
        allPhotos.length,

      gallery_sections:
        gallery.sections,

      guest_reviews:
        reviewData.reviews,

      reviews_loaded:
        reviewData.review_count_loaded,

      photos_has_more:
        gallery.has_more_photos,

      reviews_next_page_token:
        reviewData.next_page_token
    },

    /* GALLERY */

    gallery: {
      photos: allPhotos,

      photo_urls: allPhotos.map(
        photo => photo.url
      ),

      sections:
        gallery.sections,

      photo_count_loaded:
        allPhotos.length,

      has_more_photos:
        gallery.has_more_photos
    },

    /* REVIEWS */

    reviews: {
      items: reviewData.reviews,

      reviews: reviewData.reviews,

      review_count_loaded:
        reviewData.review_count_loaded,

      total_review_count:
        hotel.review_count,

      reviews_breakdown:
        hotel.reviews_breakdown,

      other_reviews:
        hotel.other_reviews,

      next_page_token:
        reviewData.next_page_token,

      pages_loaded:
        reviewData.pages_loaded
    },

    /* PRICING */

    pricing: {
      currency: hotel.currency,

      nights: hotel.nights,

      rate_per_night:
        hotel.rate_per_night,

      total_rate:
        hotel.total_rate,

      featured_prices:
        hotel.featured_prices,

      prices:
        hotel.prices,

      booking_options:
        hotel.booking_options,

      room_options:
        hotel.room_options
    },

    /* SEARCH */

    search: {
      destination:
        q.destination,

      checkin:
        q.checkin,

      checkout:
        q.checkout,

      rooms:
        q.rooms,

      adults:
        q.adults,

      children:
        q.children,

      babies:
        q.babies,

      seniors:
        q.seniors,

      currency:
        q.currency
    },

    /* ORIGINAL SOURCE DATA */

    raw: {
      property: cleanRaw(
        data.google_hotels
      ),

      photos: cleanRaw(
        data.google_hotels_photos
      ),

      reviews: cleanRaw(
        data.google_hotels_reviews
      ),

      review_pages_loaded:
        reviewData.pages_loaded
    },

    /* METADATA */

    meta: {
      source:
        "SerpApi Google Hotels",

      frontend_requests_required: 1,

      serpapi_requests_attempted:
        totalAttempts,

      serpapi_requests_succeeded:
        totalSucceeded,

      review_pages_loaded:
        reviewData.pages_loaded,

      review_pagination_errors:
        reviewData.errors,

      sources: status,

      has_address:
        hotel.address_available,

      has_photos:
        allPhotos.length > 0,

      has_reviews:
        reviewData.reviews.length > 0,

      room_photos_available:
        hotel.room_options.some(
          r => r.has_room_photos
        ) ||
        hotel.booking_options.some(
          option =>
            option.rooms.some(
              r => r.has_room_photos
            )
        ),

      has_prices:
        hotel.price_per_night !== null ||
        hotel.total_price !== null,

      retrieved_at:
        new Date().toISOString()
    }
  });
}
