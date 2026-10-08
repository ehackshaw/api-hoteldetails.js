
/*
============================================================
BOKKARA — COMBINED HOTEL DETAILS BACKEND
File: api/hoteldetails.js
============================================================

ONE FRONTEND REQUEST
THREE CONCURRENT SERPAPI REQUESTS

1. google_hotels         Property details, rates, rooms
2. google_hotels_photos  Photo gallery and sections
3. google_hotels_reviews Guest reviews

No follow-up requests.
No pagination requests.
No fabricated property data.

Environment:
SERPAPI_API_KEY=your_private_key

Works with Vercel Node.js functions.
============================================================
*/

const SERPAPI_URL = "https://serpapi.com/search.json";
const TIMEOUT_MS = 25000;

function object(v) {
  return v && typeof v === "object" &&
    !Array.isArray(v) ? v : {};
}

function array(v) {
  return Array.isArray(v) ? v : [];
}

function first(...values) {
  return values.find(v =>
    v !== undefined && v !== null && v !== ""
  ) ?? null;
}

function string(v) {
  return v === null || v === undefined ||
    typeof v === "object" ? "" : String(v).trim();
}

function number(v) {
  if (v === null || v === undefined || v === "") {
    return null;
  }

  if (typeof v === "object") {
    return number(first(
      v.extracted_lowest,
      v.extracted_price,
      v.amount,
      v.value
    ));
  }

  const parsed = Number(
    String(v).replace(/[^0-9.-]/g, "")
  );

  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(v) {
  const s = string(v);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) &&
      d.toISOString().slice(0, 10) === s ? s : "";
  }

  if (!s) return "";

  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toISOString().slice(0, 10);
}

function positiveInteger(v, fallback, min, max) {
  const n = Number(v);

  return Number.isInteger(n) && n >= min && n <= max
    ? n
    : fallback;
}

function rate(v) {
  const r = object(v);

  return {
    display: string(first(
      r.lowest,
      r.price,
      r.amount
    )),
    amount: number(first(
      r.extracted_lowest,
      r.extracted_price,
      r.amount
    )),
    before_taxes_fees: string(r.before_taxes_fees),
    before_taxes_fees_amount:
      number(r.extracted_before_taxes_fees),
    raw: r
  };
}

function uniqueBy(items, getKey) {
  const seen = new Set();

  return items.filter(item => {
    const key = getKey(item);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function validHttpUrl(v) {
  const s = string(v);
  return /^https?:\/\//i.test(s) ? s : "";
}

/*
============================================================
READ QUERY PARAMETERS
============================================================
*/

function getQuery(req) {
  const q = req.method === "POST"
    ? object(req.body)
    : object(req.query);

  const currency = string(q.currency || "USD")
    .toUpperCase();

  return {
    property_token: string(first(
      q.property_token,
      q.propertyToken,
      q.token
    )),

    destination: string(first(
      q.destination,
      q.q,
      q.location
    )),

    checkin: dateValue(first(
      q.checkin,
      q.check_in_date
    )),

    checkout: dateValue(first(
      q.checkout,
      q.check_out_date
    )),

    adults: positiveInteger(q.adults, 2, 1, 40),
    children: positiveInteger(q.children, 0, 0, 40),
    rooms: positiveInteger(q.rooms, 1, 1, 10),

    babies: positiveInteger(q.babies, 0, 0, 40),
    seniors: positiveInteger(q.seniors, 0, 0, 40),

    children_ages: string(q.children_ages),

    currency: /^[A-Z]{3}$/.test(currency)
      ? currency
      : "USD",

    hl: "en",
    gl: "us"
  };
}

function validateQuery(q) {
  if (!q.property_token) {
    throw new Error("Missing property_token.");
  }

  if (q.property_token.length > 2048) {
    throw new Error("Invalid property_token.");
  }

  if (!q.destination) {
    throw new Error("Missing destination.");
  }

  if (!q.checkin || !q.checkout) {
    throw new Error(
      "Valid checkin and checkout dates are required."
    );
  }

  if (q.checkout <= q.checkin) {
    throw new Error(
      "Checkout must be later than checkin."
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
        "Invalid children_ages. Provide one age " +
        "between 1 and 17 for each child."
      );
    }
  }
}

/*
============================================================
SERPAPI FETCH
ONE REQUEST PER ENGINE
============================================================
*/

async function callSerpApi(engine, params, apiKey) {
  const url = new URL(SERPAPI_URL);

  url.searchParams.set("engine", engine);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("output", "json");

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(
        string(data.error) ||
        `${engine} returned HTTP ${response.status}`
      );
    }

    return data;

  } finally {
    clearTimeout(timer);
  }
}

/*
============================================================
PROPERTY DETAILS NORMALIZATION
============================================================
*/

function normalizeBookingOption(v) {
  const o = object(v);

  return {
    source: string(first(o.source, o.name)),
    link: validHttpUrl(o.link),
    logo: validHttpUrl(o.logo),
    num_guests: number(o.num_guests),
    rate_per_night: rate(o.rate_per_night),
    total_rate: rate(o.total_rate),
    rooms: array(o.rooms),
    benefits: first(o.benefits, null),
    raw: o
  };
}

function normalizeProperty(data, q) {
  const p = object(data);

  const coordinates = object(p.gps_coordinates);

  const address = string(first(
    p.address,
    p.formatted_address,
    p.full_address,
    p.street_address
  ));

  const amenities = array(p.amenities);

  const featured = array(p.featured_prices)
    .map(normalizeBookingOption);

  const prices = array(p.prices)
    .map(normalizeBookingOption);

  const nightly = rate(p.rate_per_night);
  const total = rate(p.total_rate);

  const rating = number(first(
    p.overall_rating,
    p.rating,
    p.guest_rating
  ));

  const stars = number(first(
    p.extracted_hotel_class,
    p.hotel_class,
    p.stars
  ));

  const nights = Math.round(
    (
      Date.parse(q.checkout + "T00:00:00Z") -
      Date.parse(q.checkin + "T00:00:00Z")
    ) / 86400000
  );

  return {
    property_token: string(first(
      p.property_token,
      q.property_token
    )),

    name: string(p.name),
    type: string(p.type),
    description: string(p.description),

    website: validHttpUrl(p.link),
    logo: validHttpUrl(p.logo),

    address,
    address_available: Boolean(address),
    location_label: address || q.destination,

    phone: string(p.phone),
    phone_link: string(p.phone_link),

    gps_coordinates: {
      latitude: number(coordinates.latitude),
      longitude: number(coordinates.longitude)
    },

    check_in_time: string(p.check_in_time),
    check_out_time: string(p.check_out_time),

    stars,
    hotel_class: string(p.hotel_class),

    rating,
    rating_display: rating === null
      ? null
      : rating.toFixed(1),

    review_count: number(first(
      p.reviews,
      p.review_count
    )),

    location_rating: number(p.location_rating),

    reviews_breakdown: first(
      p.reviews_breakdown,
      null
    ),

    other_reviews: first(
      p.other_reviews,
      null
    ),

    amenities,
    excluded_amenities: array(p.excluded_amenities),

    amenities_detailed: first(
      p.amenities_detailed,
      null
    ),

    essential_info: first(
      p.essential_info,
      null
    ),

    nearby_places: array(p.nearby_places),

    eco_certified: p.eco_certified === true,

    sustainability: first(
      p.sustainability,
      null
    ),

    accessibility: first(
      p.accessibility,
      null
    ),

    rate_per_night: nightly,
    total_rate: total,

    price_per_night: nightly.amount,
    total_price: total.amount,
    currency: q.currency,
    nights,

    featured_prices: featured,
    prices,
    booking_options: [...featured, ...prices],

    room_options: array(p.rooms),

    policies: first(p.policies, null),

    images: array(p.images),

    thumbnail: validHttpUrl(p.thumbnail),

    raw: p
  };
}

/*
============================================================
PHOTOS NORMALIZATION
============================================================
*/

function normalizePhoto(v, sectionTitle = "") {
  const p = object(v);

  const url = validHttpUrl(first(
    p.original_image,
    p.image,
    p.url,
    p.src,
    p.thumbnail
  ));

  if (!url) return null;

  return {
    url,

    original_image: validHttpUrl(
      p.original_image
    ) || url,

    thumbnail: validHttpUrl(
      p.thumbnail
    ) || url,

    title: string(first(
      p.title,
      p.caption,
      p.description
    )),

    section: sectionTitle,

    raw: p
  };
}

function normalizePhotos(data) {
  const sections = array(data.sections);

  const normalizedSections = sections.map(section => {
    const title = string(section.title);

    const photos = array(first(
      section.photos,
      section.images
    ))
      .map(p => normalizePhoto(p, title))
      .filter(Boolean);

    return {
      title,
      total: number(section.total),
      photos,
      next_page_token:
        string(section.next_page_token) || null,
      raw: section
    };
  });

  const topLevelPhotos = array(first(
    data.photos,
    data.images
  ))
    .map(p => normalizePhoto(p))
    .filter(Boolean);

  const allPhotos = uniqueBy(
    [
      ...topLevelPhotos,
      ...normalizedSections.flatMap(s => s.photos)
    ],
    p => p.url
  );

  return {
    sections: normalizedSections,
    photos: allPhotos,
    photo_urls: allPhotos.map(p => p.url),
    photo_count_loaded: allPhotos.length,
    has_more_photos: normalizedSections.some(
      s => Boolean(s.next_page_token)
    ),
    raw: data
  };
}

/*
============================================================
REVIEWS NORMALIZATION
============================================================
*/

function normalizeReview(v) {
  const r = object(v);
  const user = object(r.user);

  return {
    author: string(user.name),
    author_url: validHttpUrl(user.link),
    author_photo: validHttpUrl(user.thumbnail),

    source: string(r.source),
    source_icon: validHttpUrl(r.source_icon),

    rating: number(r.rating),
    best_rating: number(r.best_rating),

    date: string(r.date),
    text: string(first(r.snippet, r.text)),

    link: validHttpUrl(r.link),

    images: array(r.images),

    subratings: first(r.subratings, null),

    hotel_highlights: array(r.hotel_highlights),

    review_details: first(
      r.details,
      r.review_details,
      null
    ),

    raw: r
  };
}

function normalizeReviews(data) {
  const reviews = array(data.reviews)
    .map(normalizeReview);

  return {
    reviews,

    review_count_loaded: reviews.length,

    next_page_token: string(first(
      object(data.serpapi_pagination).next_page_token,
      object(data.pagination).next_page_token,
      data.next_page_token
    )) || null,

    pagination: first(
      data.serpapi_pagination,
      data.pagination,
      null
    ),

    raw: data
  };
}

/*
============================================================
REMOVE SERPAPI METADATA FROM PUBLIC RAW RESPONSE
============================================================
*/

function cleanRaw(data) {
  return Object.fromEntries(
    Object.entries(object(data)).filter(
      ([key]) => ![
        "search_metadata",
        "search_parameters",
        "search_information"
      ].includes(key)
    )
  );
}

/*
============================================================
MAIN VERCEL API HANDLER
============================================================
*/

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
      error: "SERPAPI_API_KEY is not configured"
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

  /*
    GOOGLE HOTELS PROPERTY DETAILS
    Uses dates and original search destination.
  */

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

  if (q.children > 0 && q.children_ages) {
    propertyParams.children_ages = q.children_ages;
  }

  /*
    PHOTO AND REVIEW ENGINES
    Both identify the hotel by property_token.
  */

  const photoParams = {
    property_token: q.property_token,
    hl: q.hl
  };

  const reviewParams = {
    property_token: q.property_token,
    hl: q.hl,
    sort_by: 1
  };

  /*
    Run all three in parallel.
    Each engine is called exactly once.
  */

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

  for (let i = 0; i < engines.length; i++) {
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
        error: result.reason?.message ||
          "Request failed"
      };

      data[engine] = {};
    }
  }

  /*
    Property details are required.
    Photos and reviews may fail independently.
  */

  if (!status.google_hotels.success) {
    return res.status(502).json({
      success: false,
      error: "Unable to retrieve hotel property details.",
      property_token: q.property_token,
      sources: status
    });
  }

  const propertyData = data.google_hotels;

  if (!string(propertyData.name)) {
    return res.status(404).json({
      success: false,
      error:
        "No matching property details were returned.",
      property_token: q.property_token,
      sources: status
    });
  }

  const hotel = normalizeProperty(
    propertyData,
    q
  );

  const gallery = normalizePhotos(
    data.google_hotels_photos
  );

  const reviewData = normalizeReviews(
    data.google_hotels_reviews
  );

  /*
    Include any images supplied by the
    main Google Hotels property response.
  */

  const propertyImages = array(propertyData.images)
    .map(p => normalizePhoto(p, "Property"))
    .filter(Boolean);

  if (hotel.thumbnail) {
    propertyImages.unshift({
      url: hotel.thumbnail,
      original_image: hotel.thumbnail,
      thumbnail: hotel.thumbnail,
      title: "",
      section: "Property",
      raw: {}
    });
  }

  const allPhotos = uniqueBy(
    [...gallery.photos, ...propertyImages],
    p => p.url
  );

  /*
    Unified response for Shopify.
  */

  return res.status(200).json({
    success: true,

    partial: !(
      status.google_hotels_photos.success &&
      status.google_hotels_reviews.success
    ),

    property_token: q.property_token,

    hotel: {
      ...hotel,

      images: allPhotos,

      photos: allPhotos.map(p => p.url),

      image: allPhotos[0]?.url || "",

      image_count: allPhotos.length,

      gallery_sections: gallery.sections,

      guest_reviews: reviewData.reviews,

      reviews_loaded:
        reviewData.review_count_loaded,

      photos_has_more:
        gallery.has_more_photos,

      reviews_next_page_token:
        reviewData.next_page_token
    },

    /*
      Separate structured sections
      for the details page navigation.
    */

    gallery: {
      photos: allPhotos,
      photo_urls: allPhotos.map(p => p.url),
      sections: gallery.sections,
      photo_count_loaded: allPhotos.length,
      has_more_photos: gallery.has_more_photos
    },

    reviews: {
      items: reviewData.reviews,
      review_count_loaded:
        reviewData.review_count_loaded,
      total_review_count: hotel.review_count,
      reviews_breakdown:
        hotel.reviews_breakdown,
      other_reviews:
        hotel.other_reviews,
      next_page_token:
        reviewData.next_page_token
    },

    pricing: {
      currency: hotel.currency,
      nights: hotel.nights,
      rate_per_night: hotel.rate_per_night,
      total_rate: hotel.total_rate,
      featured_prices: hotel.featured_prices,
      prices: hotel.prices,
      booking_options: hotel.booking_options,
      room_options: hotel.room_options
    },

    search: {
      destination: q.destination,
      checkin: q.checkin,
      checkout: q.checkout,
      rooms: q.rooms,
      adults: q.adults,
      children: q.children,
      babies: q.babies,
      seniors: q.seniors,
      currency: q.currency
    },

    /*
      Full source data retained.
      No source fields intentionally omitted
      except SerpApi request metadata.
    */

    raw: {
      property: cleanRaw(data.google_hotels),
      photos: cleanRaw(data.google_hotels_photos),
      reviews: cleanRaw(data.google_hotels_reviews)
    },

    meta: {
      source: "SerpApi Google Hotels",

      frontend_requests_required: 1,

      serpapi_requests_attempted: 3,

      serpapi_requests_succeeded:
        Object.values(status)
          .filter(s => s.success).length,

      sources: status,

      has_address: hotel.address_available,

      has_photos: allPhotos.length > 0,

      has_reviews:
        reviewData.reviews.length > 0,

      has_prices:
        hotel.price_per_night !== null ||
        hotel.total_price !== null,

      retrieved_at: new Date().toISOString()
    }
  });
}
